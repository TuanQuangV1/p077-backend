"""Tests for detection clustering and AI result assembly."""

from __future__ import annotations

from typing import Any

import pytest

from src.services import analysis


def _detection(topic: str, kind: str, t_sec: float, **evidence: Any) -> dict[str, Any]:
    return {
        "kind": kind,
        "topic": topic,
        "severity": "medium",
        "confidence": 0.8,
        "tSec": t_sec,
        "endSec": t_sec + 1.0,
        "evidence": evidence,
    }


def test_cluster_detections_groups_a_stalled_consumer_after_its_cause() -> None:
    """One incident, ordered by onset: the dead sensor must precede the stalled consumer."""
    detections = [
        _detection("/cmd_vel", "silent_node", 427.301),
        _detection("/scan", "silent_node", 425.133),
        _detection("/imu", "frequency_gap", 364.67),
    ]

    clusters = analysis._cluster_detections(detections)

    assert clusters == [[2], [1, 0]]


def test_cluster_detections_splits_incidents_beyond_the_window() -> None:
    detections = [
        _detection("/odom", "frequency_gap", 100.0),
        _detection("/odom", "frequency_gap", 100.0 + analysis._CLUSTER_WINDOW_SEC),
        _detection("/odom", "frequency_gap", 200.0),
    ]

    assert analysis._cluster_detections(detections) == [[0, 1], [2]]


def test_cluster_detections_handles_empty_input() -> None:
    assert analysis._cluster_detections([]) == []


def test_build_ai_results_maps_cluster_findings_onto_their_own_anomaly(monkeypatch) -> None:
    """Each anomaly keeps its own index while sharing the incident's root cause."""
    detections = [
        _detection("/cmd_vel", "silent_node", 427.301),
        _detection("/scan", "silent_node", 425.133),
    ]

    def fake_cluster(group: list[dict[str, Any]]) -> dict[str, Any]:
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


def test_build_ai_results_keeps_indices_aligned_when_a_cluster_call_fails(monkeypatch) -> None:
    """A failed cluster must not renumber its anomalies onto earlier ones."""
    detections = [
        _detection("/odom", "frequency_gap", 100.0),
        _detection("/scan", "silent_node", 400.0),
        _detection("/imu", "frequency_gap", 401.0),
    ]

    def failing_cluster(group: list[dict[str, Any]]) -> dict[str, Any]:
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
