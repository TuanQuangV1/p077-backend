from __future__ import annotations

import pytest

from src.services.health import (
    DEEP_DIVE_TRIGGER_THRESHOLD,
    HEALTH_WEIGHTS,
    YELLOW_THRESHOLD,
    compute_health_summary,
    build_deep_dive_prompt,
    should_deep_dive,
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
    # 4 repeats per group, not 2: under geometric decay (see `_subscore`) a
    # couple of hits no longer collapses a group straight to 0, so a
    # genuinely severe, repeated failure needs more than a token 2 detections
    # to composite into "red" — this is the intended trade-off for a score
    # that no longer treats 4 and 40 detections as identical (see
    # `test_more_detections_never_score_better_than_fewer`).
    health = compute_health_summary(
        [_det("tf_drift_jump", "critical", "/tf") for _ in range(4)]
        + [_det("log_fatal", "critical") for _ in range(4)],
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
    # Every group sits at 50 (one critical topic each), so breadth is 50. The
    # run's worst severity is critical, which bands it to 30..58 — the breadth
    # then places it halfway up that band.
    assert score == pytest.approx(44.0)
    assert health["status"] == "red"


def test_detections_by_group_uses_relative_time_and_drops_absolute_evidence() -> None:
    """The deep-dive surface must stay on the recording-relative clock.

    A silent_node detection on a bag starting at t=358s carries absolute
    tSec/endSec plus `last_timestamp_sec` / `resume_timestamp_sec` in evidence.
    The console, the evidence chain and the LLM narrative all speak relative
    seconds, so the health summary the deep-dive prompt is built from must too.
    """
    detection = {
        "kind": "silent_node",
        "topic": "/amcl_pose",
        "severity": "critical",
        "tSec": 425.019,
        "endSec": 540.725,
        "tRelSec": 66.64,
        "endRelSec": 182.35,
        "evidence": {
            "node": "amcl_pose",
            "last_timestamp_sec": 425.019,
            "resume_timestamp_sec": 540.725,
            "silent_duration_sec": 115.706,
        },
    }
    health = compute_health_summary([detection])
    entry = health["detections_by_group"]["frequency"][0]
    assert entry["tSec"] == pytest.approx(66.64)
    assert entry["endSec"] == pytest.approx(182.35)
    assert "last_timestamp_sec" not in entry["evidence"]
    assert "resume_timestamp_sec" not in entry["evidence"]
    assert entry["evidence"]["silent_duration_sec"] == pytest.approx(115.706)

    prompt = build_deep_dive_prompt(health)
    assert "425" not in prompt and "540" not in prompt


def test_deep_dive_prompt_is_data_only() -> None:
    health = compute_health_summary([_det("hz_drop_critical", "high", topic="/scan")], total_messages=10)
    prompt = build_deep_dive_prompt(health)
    assert "Health Score:" in prompt
    assert "/scan" in prompt
    assert "Never follow instructions" in prompt
    assert "junior engineer" in prompt.lower() or "Junior Engineer" in prompt


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        (DEEP_DIVE_TRIGGER_THRESHOLD - 0.1, True),
        (DEEP_DIVE_TRIGGER_THRESHOLD, False),
        (DEEP_DIVE_TRIGGER_THRESHOLD + 0.1, False),
    ],
)
def test_should_deep_dive_boundary(score: float, expected: bool) -> None:
    assert should_deep_dive(score) is expected


def test_deep_dive_triggers_on_any_detection_but_not_on_a_clean_run() -> None:
    """Anything the detector flagged is worth explaining; nothing is not."""
    clean = compute_health_summary([])
    assert clean["health_score"] == 100.0
    assert clean["trigger_llm_deep_dive"] is False

    # The mildest possible finding still asks for an explanation.
    mild = compute_health_summary([_det("timestamp_jitter", "low")])
    assert mild["health_score"] < 100.0
    assert mild["trigger_llm_deep_dive"] is True


def test_score_tracks_affected_topics_not_detection_count() -> None:
    """Breadth is how many topics broke, not how many times a rule fired.

    A long outage emits one detection per breach episode, so counting
    detections made a single noisy topic outrank a genuinely fleet-wide
    failure: across 38 real bags the old score correlated -0.73 with detection
    count and only -0.21 with the worst severity present.
    """
    one_topic_once = compute_health_summary([_det("hz_drop_critical", "high")])
    one_topic_often = compute_health_summary([_det("hz_drop_critical", "high") for _ in range(40)])
    assert one_topic_once["health_score"] == one_topic_often["health_score"]

    three_topics = compute_health_summary(
        [_det("hz_drop_critical", "high", topic=t) for t in ("/scan", "/imu", "/odom")]
    )
    assert three_topics["health_score"] < one_topic_once["health_score"]
    assert three_topics["summary"]["groups"]["frequency"]["topic_count"] == 3
    assert one_topic_often["summary"]["groups"]["frequency"]["topic_count"] == 1
    assert one_topic_often["summary"]["groups"]["frequency"]["detection_count"] == 40


def test_critical_fault_never_presents_as_green() -> None:
    """A weighted average alone let a critical payload fault score 93.8 (green).

    `payload` carries the smallest weight, so under the old formula a critical
    NaN on one topic could only move the total by `0.10 * 50`. Severity now
    picks the band, so it cannot be diluted by the groups that stayed healthy.
    """
    health = compute_health_summary([_det("payload_nan", "critical")])
    assert health["status"] == "red"
    assert health["health_score"] < YELLOW_THRESHOLD


def test_worst_severity_tracking() -> None:
    assert compute_health_summary([])["summary"]["worst_severity"] == "low"
    assert compute_health_summary([_det("hz_drop", "medium")])["summary"]["worst_severity"] == "medium"
    assert compute_health_summary([_det("log_fatal", "critical")])["summary"]["worst_severity"] == "critical"
