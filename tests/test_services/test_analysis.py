"""Tests for detection clustering and AI result assembly."""

from __future__ import annotations

from typing import Any

import pytest

from src.models.schemas import AnalysisRun, AIResultSummary, EvidenceItem
from src.services import analysis


def _run(**overrides: Any) -> AnalysisRun:
    fields = {
        "id": "run_x",
        "rosbagId": "x",
        "rosbagName": "x.mcap",
        "robotType": "amr",
        "status": "succeeded",
        "progress": 100,
        "stage": "done",
        "startedAt": "2026-01-01T00:00:00+00:00",
        "finishedAt": "2026-01-01T00:00:01+00:00",
        "anomalyCount": 0,
        "worstSeverity": None,
        "model": "gpt-4o-mini",
        "totalLatencyMs": 0,
        "promptTokens": 0,
        "completionTokens": 0,
        "costUsd": 0.0,
    }
    fields.update(overrides)
    return AnalysisRun(**fields)


def _ai_result(prompt_tokens: int, completion_tokens: int) -> AIResultSummary:
    return AIResultSummary(
        id="ai_001",
        runId="run_x",
        anomalyId="anomaly_001",
        issue="issue",
        rootCause="root cause",
        confidence=0.8,
        explanation="explanation",
        suggestedFix=[],
        evidence=[EvidenceItem(topic="/scan", tSec=0.0, detail="detail")],
        reviewStatus="pending",
        model="llm-explain",
        latencyMs=0,
        promptTokens=prompt_tokens,
        completionTokens=completion_tokens,
        vllmRequestId="vllm_req_001",
    )


def _detection(
    topic: str, kind: str, t_sec: float, endSec: float | None = None, **evidence: Any
) -> dict[str, Any]:
    return {
        "kind": kind,
        "topic": topic,
        "severity": "medium",
        "confidence": 0.8,
        "tSec": t_sec,
        "endSec": t_sec + 1.0 if endSec is None else endSec,
        "evidence": evidence,
    }


def test_anomaly_summaries_carries_the_structured_evidence_dict() -> None:
    """The raw evidence dict must reach the API response, not just the flattened metric string."""
    detections = [_detection("/tf", "tf_conflict", 10.0, max_jump_m=0.67, child_frame="odom")]

    summaries = analysis._anomaly_summaries("run_x", detections)

    assert summaries[0]["evidence"] == {"max_jump_m": 0.67, "child_frame": "odom"}
    assert "max jump m 0.67" in summaries[0]["metric"]


def test_cluster_detections_groups_a_stalled_consumer_after_its_cause() -> None:
    """One incident, ordered by onset: the dead sensor must precede the stalled consumer.

    Spans are the real F1_01 ones: the lidar goes silent for 115s and the
    controller stalls 2.2s later and stays down for the rest of it, so the two
    overlap for almost their whole length.
    """
    detections = [
        _detection("/cmd_vel", "silent_node", 427.301, endSec=540.287),
        _detection("/scan", "silent_node", 425.133, endSec=540.223),
        _detection("/imu", "frequency_gap", 364.67),
    ]

    clusters = analysis._cluster_detections(detections)

    assert clusters == [[2], [1, 0]]


def test_cluster_detections_starts_a_new_incident_once_the_previous_one_ended() -> None:
    """A detection beginning after the running incident closed is a separate incident."""
    detections = [
        _detection("/odom", "frequency_gap", 100.0, endSec=110.0),
        _detection("/odom", "frequency_gap", 105.0, endSec=115.0),  # overlaps -> same
        _detection("/odom", "frequency_gap", 200.0, endSec=210.0),  # after the gap -> new
    ]

    assert analysis._cluster_detections(detections) == [[0, 1], [2]]


def test_cluster_detections_keeps_a_long_fault_with_the_cascade_it_outlasts() -> None:
    """A consumer stalling mid-way through a 40s transform gap is the same incident.

    Onset-distance clustering split these apart (13.2s > slack), leaving the
    cascade in a cluster with no candidate cause in it at all.
    """
    detections = [
        _detection("/tf", "tf_missing_gap", 55.0, endSec=95.0),
        _detection("/cmd_vel", "frequency_gap", 68.2, endSec=95.0),
    ]

    assert analysis._cluster_detections(detections) == [[0, 1]]


def test_cluster_detections_splits_incidents_with_no_overlap() -> None:
    """Two genuinely separate faults must not be merged just because both are long."""
    detections = [
        _detection("/scan", "silent_node", 10.0, endSec=30.0),
        _detection("/imu", "clock_drift", 100.0, endSec=140.0),
    ]

    assert analysis._cluster_detections(detections) == [[0], [1]]


def test_cluster_detections_handles_empty_input() -> None:
    assert analysis._cluster_detections([]) == []


def test_build_ai_results_maps_cluster_findings_onto_their_own_anomaly(monkeypatch) -> None:
    """Each anomaly keeps its own index while sharing the incident's root cause."""
    detections = [
        _detection("/cmd_vel", "silent_node", 427.301, endSec=540.287),
        _detection("/scan", "silent_node", 425.133, endSec=540.223),
    ]

    def fake_cluster(group: list[dict[str, Any]], recording=None) -> dict[str, Any]:
        # Earliest onset first, so the cause /scan is index 1 and /cmd_vel index 2.
        assert [item["topic"] for item in group] == ["/scan", "/cmd_vel"]
        return {
            "root_cause": "/scan stopped publishing and Nav2 stalled behind it.",
            "explanation": "/scan died at 425.133s; /cmd_vel followed 2.17s later.",
            "recommended_actions": ["Restart the /scan driver."],
            "findings": {
                1: {"role": "primary", "detail": "The lidar driver stopped publishing."},
                2: {"role": "consequence", "detail": "Nav2 stopped commanding velocity."},
            },
        }

    monkeypatch.setattr(analysis, "is_llm_configured", lambda: True)
    monkeypatch.setattr(analysis, "explain_detection_cluster", fake_cluster)

    results = analysis._build_ai_results("run_x", detections)

    assert [r.anomalyId for r in results] == ["anomaly_001", "anomaly_002"]
    assert all(r.rootCause.startswith("/scan stopped publishing") for r in results)
    assert all(r.suggestedFix == ["Restart the /scan driver."] for r in results)
    assert results[0].evidence[0].detail.startswith("consequence:")
    assert results[1].evidence[0].detail.startswith("primary:")


def test_build_ai_results_attaches_every_cluster_findings_evidence_item(monkeypatch) -> None:
    """A reviewer opening any one result should see the whole incident's evidence chain."""
    detections = [
        _detection("/cmd_vel", "silent_node", 427.301, endSec=540.287),
        _detection("/scan", "silent_node", 425.133, endSec=540.223),
    ]

    def fake_cluster(group: list[dict[str, Any]], recording=None) -> dict[str, Any]:
        return {
            "root_cause": "/scan stopped publishing and Nav2 stalled behind it.",
            "explanation": "/scan died at 425.133s; /cmd_vel followed 2.17s later.",
            "recommended_actions": ["Restart the /scan driver."],
            "findings": {
                1: {"role": "primary", "detail": "The lidar driver stopped publishing."},
                2: {"role": "consequence", "detail": "Nav2 stopped commanding velocity."},
            },
        }

    monkeypatch.setattr(analysis, "is_llm_configured", lambda: True)
    monkeypatch.setattr(analysis, "explain_detection_cluster", fake_cluster)

    results = analysis._build_ai_results("run_x", detections)

    # results[0] is /cmd_vel (offset 2, consequence); results[1] is /scan (offset 1, primary).
    assert len(results[0].evidence) == 2
    assert len(results[1].evidence) == 2
    assert results[0].evidence[0].detail.startswith("consequence:")
    assert results[0].evidence[1].detail.startswith("primary:")
    assert results[1].evidence[0].detail.startswith("primary:")
    assert results[1].evidence[1].detail.startswith("consequence:")


def test_build_ai_results_single_detection_cluster_keeps_one_evidence_item(monkeypatch) -> None:
    detections = [_detection("/scan", "silent_node", 100.0)]
    monkeypatch.setattr(analysis, "is_llm_configured", lambda: True)
    monkeypatch.setattr(
        analysis,
        "explain_detection_cluster",
        lambda group: {"root_cause": "rc", "explanation": "e", "recommended_actions": [], "findings": {}},
    )

    results = analysis._build_ai_results("run_x", detections)

    assert len(results[0].evidence) == 1


def test_build_ai_results_attributes_cluster_usage_to_first_result_only(monkeypatch) -> None:
    """One chat_completion call explains a whole cluster; summing per-row usage must not overcount."""
    detections = [
        _detection("/scan", "silent_node", 425.133),
        _detection("/cmd_vel", "silent_node", 427.301),
    ]

    def fake_cluster(group: list[dict[str, Any]], recording=None) -> dict[str, Any]:
        return {
            "root_cause": "rc",
            "explanation": "e",
            "recommended_actions": [],
            "findings": {},
            "usage": {"prompt_tokens": 120, "completion_tokens": 40, "latency_ms": 900},
        }

    monkeypatch.setattr(analysis, "is_llm_configured", lambda: True)
    monkeypatch.setattr(analysis, "explain_detection_cluster", fake_cluster)

    results = analysis._build_ai_results("run_x", detections)

    assert (results[0].promptTokens, results[0].completionTokens, results[0].latencyMs) == (120, 40, 900)
    assert (results[1].promptTokens, results[1].completionTokens, results[1].latencyMs) == (0, 0, 0)
    assert sum(r.promptTokens for r in results) == 120


def test_build_ai_results_keeps_indices_aligned_when_a_cluster_call_fails(monkeypatch) -> None:
    """A failed cluster must not renumber its anomalies onto earlier ones."""
    detections = [
        _detection("/odom", "frequency_gap", 100.0),
        _detection("/scan", "silent_node", 400.0),
        _detection("/imu", "frequency_gap", 401.0),
    ]

    def failing_cluster(group: list[dict[str, Any]], recording=None) -> dict[str, Any]:
        if any(item["topic"] == "/scan" for item in group):
            raise RuntimeError("upstream down")
        return {
            "root_cause": "rc",
            "explanation": "exp",
            "recommended_actions": ["a"],
            "findings": {},
        }

    monkeypatch.setattr(analysis, "is_llm_configured", lambda: True)
    monkeypatch.setattr(analysis, "explain_detection_cluster", failing_cluster)

    results = analysis._build_ai_results("run_x", detections)

    assert [r.anomalyId for r in results] == ["anomaly_001", "anomaly_002", "anomaly_003"]
    assert [r.model for r in results] == ["llm-explain", "canned-fallback", "canned-fallback"]


@pytest.mark.parametrize("configured", [True, False])
def test_build_ai_results_returns_one_result_per_detection(monkeypatch, configured: bool) -> None:
    detections = [_detection("/scan", "silent_node", float(i)) for i in range(0, 40, 10)]
    monkeypatch.setattr(analysis, "is_llm_configured", lambda: configured)
    monkeypatch.setattr(
        analysis,
        "explain_detection_cluster",
        lambda group: {"root_cause": "rc", "explanation": "e", "recommended_actions": [], "findings": {}},
    )

    results = analysis._build_ai_results("run_x", detections)

    assert len(results) == len(detections)
    assert [r.anomalyId for r in results] == [f"anomaly_{i:03d}" for i in range(1, len(detections) + 1)]


def test_finalize_run_llm_usage_sums_and_prices_ai_result_tokens(monkeypatch) -> None:
    class SettingsStub:
        llm_provider = "openai"
        model_name = "gpt-4o-mini"
        vllm_model_name = "unused"

    monkeypatch.setattr(analysis, "get_settings", SettingsStub)

    ai_results = [_ai_result(1_000_000, 0), _ai_result(0, 1_000_000)]
    run = _run(totalLatencyMs=0, promptTokens=0, completionTokens=0, costUsd=0.0)

    finalized = analysis._finalize_run_llm_usage(run, ai_results, started=0.0)

    assert finalized.promptTokens == 1_000_000
    assert finalized.completionTokens == 1_000_000
    assert finalized.costUsd == pytest.approx(0.15 + 0.60)
    assert finalized.totalLatencyMs >= 0


def test_finalize_run_llm_usage_zero_cost_for_unpriced_vllm_model(monkeypatch) -> None:
    class SettingsStub:
        llm_provider = "vllm"
        model_name = "unused"
        vllm_model_name = "qwen2.5-coder-32b"

    monkeypatch.setattr(analysis, "get_settings", SettingsStub)

    ai_results = [_ai_result(1000, 1000)]
    run = _run()

    finalized = analysis._finalize_run_llm_usage(run, ai_results, started=0.0)

    assert finalized.costUsd == 0.0


def _ai_result_for(anomaly_id: str, root_cause: str) -> AIResultSummary:
    return AIResultSummary(
        id=f"ai_{anomaly_id}",
        runId="run_1",
        anomalyId=anomaly_id,
        issue=root_cause,
        rootCause=root_cause,
        confidence=0.8,
        explanation="because",
        suggestedFix=["check it"],
        evidence=[EvidenceItem(topic="/tf", tSec=1.0, detail="d")],
        reviewStatus="pending",
        model="llm-explain",
        latencyMs=0,
        promptTokens=0,
        completionTokens=0,
        vllmRequestId="vllm_req_001",
    )


def test_select_run_root_cause_prefers_the_worst_severity_incident() -> None:
    """A run with several incidents must surface the most severe one, not the first."""
    detections = [
        dict(_detection("/odom", "frequency_gap", 10.0), id="anomaly_001", severity="medium"),
        dict(_detection("/tf", "tf_missing_gap", 90.0), id="anomaly_002", severity="critical"),
    ]
    ai_results = [
        _ai_result_for("anomaly_001", "odom slowed down"),
        _ai_result_for("anomaly_002", "tf broadcast stopped"),
    ]

    selected = analysis.select_run_root_cause(detections, ai_results)

    assert selected is not None
    assert selected["rootCause"] == "tf broadcast stopped"
    assert selected["severity"] == "critical"


def test_select_run_root_cause_breaks_severity_ties_by_earliest_onset() -> None:
    detections = [
        dict(_detection("/scan", "silent_node", 200.0), id="anomaly_001", severity="critical"),
        dict(_detection("/tf", "tf_missing_gap", 50.0), id="anomaly_002", severity="critical"),
    ]
    ai_results = [
        _ai_result_for("anomaly_001", "scan died"),
        _ai_result_for("anomaly_002", "tf died first"),
    ]

    selected = analysis.select_run_root_cause(detections, ai_results)

    assert selected is not None
    assert selected["rootCause"] == "tf died first"


def test_select_run_root_cause_returns_none_without_results() -> None:
    assert analysis.select_run_root_cause([], []) is None


def test_cascade_fragment_clusters_flags_actuator_only_windows() -> None:
    """A /cmd_vel-only window has no evidence of what stopped it."""
    detections = [
        _detection("/tf", "tf_missing_gap", 100.0, endSec=140.0),
        _detection("/cmd_vel", "silent_node", 102.0, endSec=140.0),
        _detection("/cmd_vel", "frequency_gap", 300.0, endSec=305.0),
    ]
    clusters = analysis._cluster_detections(detections)

    fragments = analysis._cascade_fragment_clusters(detections, clusters)

    assert len(clusters) == 2
    assert fragments == {1}


def test_cascade_fragment_clusters_keeps_a_genuine_actuator_fault() -> None:
    """When nothing upstream ever fails, /cmd_vel really is the origin."""
    detections = [
        _detection("/cmd_vel", "silent_node", 100.0, endSec=140.0),
        _detection("/cmd_vel", "frequency_gap", 101.0, endSec=140.0),
    ]
    clusters = analysis._cluster_detections(detections)

    assert analysis._cascade_fragment_clusters(detections, clusters) == set()


def test_build_ai_results_does_not_call_the_llm_for_cascade_fragments(monkeypatch) -> None:
    detections = [
        _detection("/scan", "silent_node", 100.0, endSec=140.0),
        _detection("/cmd_vel", "silent_node", 102.0, endSec=140.0),
        _detection("/cmd_vel", "frequency_gap", 300.0, endSec=305.0),
    ]
    calls: list[int] = []

    def fake_cluster(group: list[dict[str, Any]], recording=None) -> dict[str, Any]:
        calls.append(len(group))
        return {"root_cause": "rc", "explanation": "exp", "recommended_actions": [], "findings": {}}

    monkeypatch.setattr(analysis, "is_llm_configured", lambda: True)
    monkeypatch.setattr(analysis, "explain_detection_cluster", fake_cluster)

    results = analysis._build_ai_results("run_x", detections)

    assert calls == [2]  # only the real incident reached the LLM
    assert results[2].model == "cascade-fragment"
    assert "downstream consequence" in results[2].rootCause
