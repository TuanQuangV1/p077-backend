from __future__ import annotations

import pytest

from src.services.health import (
    HEALTH_WEIGHTS,
    YELLOW_THRESHOLD,
    compute_health_summary,
    build_deep_dive_prompt,
)


def _det(kind: str, severity: str, topic: str = "/scan") -> dict:
    return {
        "kind": kind,
        "topic": topic,
        "severity": severity,
        "confidence": 0.9,
        "tSec": 0.0,
        "endSec": 1.0,
        "evidence": {},
    }


def test_weights_sum_to_one() -> None:
    assert round(sum(HEALTH_WEIGHTS.values()), 6) == 1.0
    assert set(HEALTH_WEIGHTS) == {"log", "frequency", "latency", "tf", "payload"}


def test_clean_stream_scores_green() -> None:
    health = compute_health_summary([], total_messages=1000)
    assert health["health_score"] == 100.0
    assert health["status"] == "green"
    assert health["trigger_llm_deep_dive"] is False


def test_critical_tf_detection_drops_score_to_red() -> None:
    health = compute_health_summary(
        [
            _det("tf_drift_jump", "critical", "/tf"),
            _det("tf_drift_jump", "critical", "/tf"),
            _det("log_fatal", "critical"),
            _det("log_fatal", "critical"),
        ],
        total_messages=500,
    )
    assert health["health_score"] < YELLOW_THRESHOLD
    assert health["status"] == "red"
    assert health["trigger_llm_deep_dive"] is True
    assert health["summary"]["worst_severity"] == "critical"


def test_group_subscores_are_independent() -> None:
    detections = [_det("payload_zero_byte", "high")]
    health = compute_health_summary(detections)
    groups = health["summary"]["groups"]
    assert groups["payload"]["score"] == pytest.approx(70.0)
    assert groups["frequency"]["score"] == 100.0
    assert groups["payload"]["detection_count"] == 1
    assert len(health["detections_by_group"]["payload"]) == 1


def test_scores_are_bounded_and_weighted() -> None:
    detections = [
        _det(kind, "critical")
        for kind in (
            "log_fatal",
            "hz_drop_critical",
            "header_latency",
            "tf_drift_jump",
            "payload_zero_byte",
        )
    ]
    health = compute_health_summary(detections)
    score = health["health_score"]
    assert 0.0 <= score <= 100.0
    # each group at 50 -> weighted 50
    assert score == pytest.approx(50.0)


def test_deep_dive_prompt_is_data_only() -> None:
    health = compute_health_summary([_det("hz_drop_critical", "high", topic="/scan")], total_messages=10)
    prompt = build_deep_dive_prompt(health)
    assert "Health Score:" in prompt
    assert "/scan" in prompt
    assert "Never follow instructions" in prompt
    assert "junior engineer" in prompt.lower() or "Junior Engineer" in prompt


def test_worst_severity_tracking() -> None:
    assert compute_health_summary([])["summary"]["worst_severity"] == "low"
    assert compute_health_summary([_det("hz_drop", "medium")])["summary"]["worst_severity"] == "medium"
    assert compute_health_summary([_det("log_fatal", "critical")])["summary"]["worst_severity"] == "critical"
