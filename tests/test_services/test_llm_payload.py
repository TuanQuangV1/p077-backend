"""Tests for the cluster payload shaping and the causal-layer gate."""

from __future__ import annotations

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
