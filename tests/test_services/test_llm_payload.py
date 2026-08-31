"""Tests for the cluster payload shaping and the causal-layer gate."""

from __future__ import annotations

import json
from typing import Any

from src.services import llm


def _detection(topic: str, kind: str, t_sec: float, end_sec: float, severity: str = "medium") -> dict[str, Any]:
    return {
        "kind": kind,
        "topic": topic,
        "severity": severity,
        "confidence": 0.8,
        "tSec": t_sec,
        "endSec": end_sec,
        "evidence": {},
    }


def test_shape_cluster_payload_collapses_repeats_of_the_same_topic_and_kind() -> None:
    """A stalled consumer must not outvote its cause by sheer row count."""
    detections = [
        _detection("/cmd_vel", "frequency_gap", 60.0, 62.0),
        _detection("/cmd_vel", "frequency_gap", 70.0, 72.0),
        _detection("/cmd_vel", "frequency_gap", 80.0, 82.0),
        _detection("/tf", "tf_missing_gap", 55.0, 95.0),
    ]

    rows, row_positions = llm._shape_cluster_payload(detections)

    assert len(rows) == 2
    cmd_row = next(r for r in rows if r["topic"] == "/cmd_vel")
    assert cmd_row["merged_detections"] == 3
    assert cmd_row["start_sec"] == 60.0
    assert cmd_row["end_sec"] == 82.0
    assert cmd_row["duration_sec"] == 22.0
    assert sorted(row_positions[cmd_row["index"] - 1]) == [0, 1, 2]


def test_shape_cluster_payload_orders_upstream_topics_first() -> None:
    """Sensor and transform must precede the actuator regardless of onset order."""
    detections = [
        _detection("/cmd_vel", "silent_node", 10.0, 20.0),
        _detection("/scan", "silent_node", 50.0, 60.0),
        _detection("/tf", "tf_missing_gap", 40.0, 60.0),
    ]

    rows, _ = llm._shape_cluster_payload(detections)

    assert [row["topic"] for row in rows] == ["/scan", "/tf", "/cmd_vel"]
    assert [row["layer"] for row in rows] == ["sensor", "transform", "actuator"]


def test_expand_findings_applies_a_row_verdict_to_every_detection_it_stands_for() -> None:
    row_positions = [[0, 1, 2], [3]]
    row_findings = {
        1: {"role": "consequence", "detail": "stalled"},
        2: {"role": "primary", "detail": "died"},
    }

    findings = llm._expand_findings(row_findings, row_positions)

    assert findings == {
        1: {"role": "consequence", "detail": "stalled"},
        2: {"role": "consequence", "detail": "stalled"},
        3: {"role": "consequence", "detail": "stalled"},
        4: {"role": "primary", "detail": "died"},
    }


def test_gate_demotes_actuator_claimed_primary_while_transform_fault_overlaps() -> None:
    """/cmd_vel cannot originate a fault it only reacts to."""
    rows = [
        {"index": 1, "topic": "/tf", "start_sec": 55.0, "end_sec": 95.0},
        {"index": 2, "topic": "/cmd_vel", "start_sec": 58.0, "end_sec": 95.0},
    ]
    findings = {
        1: {"role": "consequence", "detail": "tf gap"},
        2: {"role": "primary", "detail": "controller died"},
    }

    gated = llm._gate_actuator_primary(rows, findings)

    assert gated[2]["role"] == "consequence"


def test_causal_order_promotes_a_consequence_that_started_before_every_primary() -> None:
    """The model labelled /cmd_vel (silent from 304s) a consequence of a /tf conflict at 331s."""
    rows = [
        {"index": 1, "topic": "/tf", "start_sec": 331.23, "end_sec": 340.13},
        {"index": 2, "topic": "/cmd_vel", "start_sec": 304.02, "end_sec": 446.32},
    ]
    findings = {
        1: {"role": "primary", "detail": "tf conflict"},
        2: {"role": "consequence", "detail": "controller stalled"},
    }

    assert llm._enforce_causal_order(rows, findings)[2]["role"] == "primary"


def test_causal_order_leaves_a_genuine_cascade_alone() -> None:
    """A controller stalling seconds after the scan that feeds it is a real consequence."""
    rows = [
        {"index": 1, "topic": "/scan", "start_sec": 60.0, "end_sec": 175.0},
        {"index": 2, "topic": "/cmd_vel", "start_sec": 62.0, "end_sec": 175.0},
    ]
    findings = {
        1: {"role": "primary", "detail": "scan died"},
        2: {"role": "consequence", "detail": "controller starved"},
    }

    assert llm._enforce_causal_order(rows, findings) == findings


def test_gate_leaves_actuator_primary_when_the_upstream_fault_started_later() -> None:
    """A transform conflict that begins 27s after the controller went silent cannot explain it.

    Measured on `F4_01`: /cmd_vel silent from 304s to the end of the recording,
    /tf conflict only from 331s. Overlap alone demoted the real injected fault.
    """
    rows = [
        {"index": 1, "topic": "/tf", "start_sec": 331.23, "end_sec": 340.13},
        {"index": 2, "topic": "/cmd_vel", "start_sec": 304.02, "end_sec": 446.32},
    ]
    findings = {
        1: {"role": "consequence", "detail": "tf conflict"},
        2: {"role": "primary", "detail": "controller died"},
    }

    assert llm._gate_actuator_primary(rows, findings)[2]["role"] == "primary"


def test_gate_leaves_a_lone_actuator_fault_as_primary() -> None:
    """/cmd_vel really is the injected fault in some recordings — no blanket ban."""
    rows = [{"index": 1, "topic": "/cmd_vel", "start_sec": 10.0, "end_sec": 20.0}]
    findings = {1: {"role": "primary", "detail": "controller died"}}

    assert llm._gate_actuator_primary(rows, findings) == findings


def test_gate_leaves_actuator_primary_when_upstream_fault_does_not_overlap() -> None:
    """An upstream fault that ended long before cannot explain this stall."""
    rows = [
        {"index": 1, "topic": "/scan", "start_sec": 10.0, "end_sec": 20.0},
        {"index": 2, "topic": "/cmd_vel", "start_sec": 200.0, "end_sec": 210.0},
    ]
    findings = {
        1: {"role": "primary", "detail": "scan gap"},
        2: {"role": "primary", "detail": "controller died"},
    }

    assert llm._gate_actuator_primary(rows, findings)[2]["role"] == "primary"


def test_gate_has_the_final_say_over_the_simultaneity_backstop() -> None:
    """A controller dying 30ms after the transform it reads is still the consequence.

    `_enforce_simultaneity` promotes near-ties to primary; the layer gate must
    run after it, or the actuator is promoted straight back.
    """
    detections = [
        _detection("/tf", "tf_missing_gap", 205.410, 250.430, severity="critical"),
        _detection("/cmd_vel", "silent_node", 205.441, 250.471, severity="critical"),
    ]
    rows, _ = llm._shape_cluster_payload(detections)
    findings = {
        1: {"role": "primary", "detail": "tf gap"},
        2: {"role": "consequence", "detail": "controller stalled"},
    }

    settled = llm._gate_actuator_primary(rows, llm._enforce_simultaneity(rows, findings))

    assert settled[1]["role"] == "primary"
    assert settled[2]["role"] == "consequence"


def _impossible_cluster() -> list[dict[str, Any]]:
    """/cmd_vel silent from 304s, /tf conflict only from 331s — as measured on `F4_01`."""
    return [
        _detection("/cmd_vel", "silent_node", 304.02, 446.32, severity="critical"),
        _detection("/tf", "tf_conflict", 331.23, 340.13, severity="critical"),
    ]


def _reply(role_for_cmd_vel: str, prose: str) -> str:
    """A cluster answer whose /tf row is index 1 and /cmd_vel row index 2."""
    return json.dumps(
        {
            "root_cause": prose,
            "explanation": "The /tf conflict starts at 331.230s.",
            "recommended_actions": ["Inspect the transform publishers."],
            "findings": [
                {"index": 1, "role": "primary", "detail": "tf conflict"},
                {"index": 2, "role": role_for_cmd_vel, "detail": "controller silent"},
            ],
        }
    )


def test_explain_cluster_asks_again_when_the_claimed_ordering_is_impossible(monkeypatch) -> None:
    """A consequence starting before its cause earns exactly one corrective round trip."""
    replies = [
        _reply("consequence", "The /tf conflict caused /cmd_vel to fall silent."),
        _reply("primary", "/cmd_vel fell silent at 304.020s, before the /tf conflict at 331.230s."),
    ]
    sent: list[list[dict[str, Any]]] = []

    def fake_chat(messages: list[dict[str, Any]], tools: Any = None) -> dict[str, Any]:
        sent.append(messages)
        return {
            "message": {"content": replies[len(sent) - 1]},
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "latency_ms": 5.0,
        }

    monkeypatch.setattr(llm, "chat_completion", fake_chat)

    result = llm.explain_detection_cluster(_impossible_cluster())

    assert len(sent) == 2
    assert "cannot start before its cause" in sent[1][-1]["content"]
    assert result["root_cause"].startswith("/cmd_vel fell silent")
    assert "Automated correction" not in result["explanation"]
    assert result["usage"]["prompt_tokens"] == 200


def test_explain_cluster_annotates_prose_the_model_refuses_to_correct(monkeypatch) -> None:
    """When the retry repeats the impossible ordering, say so next to the prose."""

    def fake_chat(messages: list[dict[str, Any]], tools: Any = None) -> dict[str, Any]:
        return {
            "message": {"content": _reply("consequence", "The /tf conflict caused /cmd_vel to fall silent.")},
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "latency_ms": 5.0,
        }

    monkeypatch.setattr(llm, "chat_completion", fake_chat)

    result = llm.explain_detection_cluster(_impossible_cluster())

    assert "Automated correction" in result["explanation"]
    assert "/cmd_vel" in result["explanation"]
    findings = result["findings"]
    assert findings[1]["role"] == "primary"


def test_explain_cluster_makes_one_call_when_the_ordering_holds(monkeypatch) -> None:
    """A genuine cascade must not pay for a second round trip."""
    calls = []

    def fake_chat(messages: list[dict[str, Any]], tools: Any = None) -> dict[str, Any]:
        calls.append(messages)
        return {
            "message": {"content": _reply("consequence", "The /scan outage starved the controller.")},
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "latency_ms": 5.0,
        }

    monkeypatch.setattr(llm, "chat_completion", fake_chat)

    llm.explain_detection_cluster(
        [
            _detection("/cmd_vel", "silent_node", 62.0, 175.0, severity="critical"),
            _detection("/tf", "tf_conflict", 60.0, 175.0, severity="critical"),
        ]
    )

    assert len(calls) == 1
