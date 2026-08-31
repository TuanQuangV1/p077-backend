"""Unit tests for the SQLite run/review persistence store."""

from __future__ import annotations

import pytest

from src.services import run_store


def test_save_and_get_run_round_trip(monkeypatch, tmp_path) -> None:
    run_store.save_run(
        {
            "id": "run_E1-1",
            "rosbagId": "E1-1",
            "rosbagName": "bag.db3",
            "robotType": "amr-delivery",
            "status": "succeeded",
            "progress": 100,
            "stage": "done",
            "startedAt": "2026-07-01T00:00:00+00:00",
            "finishedAt": "2026-07-01T00:00:05+00:00",
            "anomalyCount": 2,
            "worstSeverity": "medium",
            "model": "openai/gpt-4.1",
            "totalLatencyMs": 1200,
            "promptTokens": 10,
            "completionTokens": 5,
            "costUsd": 0.001,
        }
    )

    loaded = run_store.get_run("run_E1-1")
    assert loaded is not None
    assert loaded["rosbagId"] == "E1-1"
    assert loaded["anomalyCount"] == 2
    assert loaded["worstSeverity"] == "medium"
    assert loaded["costUsd"] == pytest.approx(0.001)

    assert run_store.get_run("missing") is None
    ids = [r["id"] for r in run_store.list_runs()]
    assert ids == ["run_E1-1"]


def test_save_run_replaces_existing(monkeypatch, tmp_path) -> None:
    run_store.save_run(
        {
            "id": "run_E1-1",
            "rosbagId": "E1-1",
            "rosbagName": "a",
            "robotType": "amr-delivery",
            "status": "uploaded",
            "progress": 0,
            "stage": "parse",
            "startedAt": "t",
            "finishedAt": None,
            "anomalyCount": 0,
            "worstSeverity": None,
            "model": "m",
            "totalLatencyMs": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "costUsd": 0.0,
        }
    )
    run_store.save_run(
        {
            "id": "run_E1-1",
            "rosbagId": "E1-1",
            "rosbagName": "a",
            "robotType": "amr-delivery",
            "status": "succeeded",
            "progress": 100,
            "stage": "done",
            "startedAt": "t",
            "finishedAt": "t2",
            "anomalyCount": 3,
            "worstSeverity": "high",
            "model": "m",
            "totalLatencyMs": 5,
            "promptTokens": 0,
            "completionTokens": 0,
            "costUsd": 0.0,
        }
    )

    assert len(run_store.list_runs()) == 1
    saved = run_store.get_run("run_E1-1")
    assert saved is not None
    assert saved["status"] == "succeeded"


def test_run_anomalies_round_trip(monkeypatch, tmp_path) -> None:
    detections = [
        {
            "kind": "frequency_gap",
            "topic": "/scan",
            "severity": "medium",
            "tSec": 1.2,
            "endSec": 3.2,
            "evidence": {"interval_sec": 2.0},
        },
        {
            "kind": "silent_node",
            "topic": "/imu",
            "severity": "low",
            "tSec": 1.0,
            "endSec": 3.2,
            "evidence": {"node": "n1"},
        },
    ]
    run_store.save_run_anomalies("run_E1-1", detections)

    assert run_store.get_run_anomalies("run_E1-1") == detections
    run_store.save_run_anomalies("run_E1-1", [detections[0]])
    assert len(run_store.get_run_anomalies("run_E1-1")) == 1


def test_ai_results_round_trip(monkeypatch, tmp_path) -> None:
    results = [
        {
            "id": "ai_001",
            "runId": "run_E1-1",
            "anomalyId": "anomaly_001",
            "issue": "gap",
            "rootCause": "starvation",
            "confidence": 0.8,
            "explanation": "x",
            "suggestedFix": ["fix"],
            "evidence": [{"topic": "/scan", "tSec": 1.2, "detail": "d"}],
            "reviewStatus": "pending",
            "model": "m",
            "latencyMs": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "llmRequestId": "llm_req_001",
        }
    ]
    run_store.save_run_ai_results("run_E1-1", results)

    assert run_store.get_run_ai_results("run_E1-1") == results
    assert run_store.get_run_ai_results("other") == []


def test_review_items_status_filter_and_update(monkeypatch, tmp_path) -> None:
    run_store.save_review_items(
        [
            {
                "id": "review_001",
                "runId": "run_E1-1",
                "anomalyId": "anomaly_001",
                "reviewStatus": "pending",
                "rootCause": "a",
                "explanation": "b",
            },
            {
                "id": "review_002",
                "runId": "run_E1-1",
                "anomalyId": "anomaly_002",
                "reviewStatus": "pending",
                "rootCause": "c",
                "explanation": "d",
            },
        ]
    )

    assert len(run_store.list_review_items()) == 2
    assert len(run_store.list_review_items(status="pending")) == 2
    assert run_store.list_review_items(status="approved") == []

    run_store.update_review_item("review_001", verdict="approved", reviewer="alice", notes="ok")
    updated = run_store.get_review_item("review_001")
    assert updated is not None
    assert updated["reviewStatus"] == "approved"
    assert updated["reviewer"] == "alice"
    assert updated["notes"] == "ok"
    again = run_store.get_review_item("review_001")
    assert again is not None
    assert again["id"] == "review_001"
    assert run_store.get_review_item("missing") is None
    assert len(run_store.list_review_items(status="pending")) == 1


def test_save_and_get_hilt_iteration(monkeypatch, tmp_path) -> None:
    run_store.save_hilt_iteration(
        "run_1", "anomaly_001", 1,
        "root cause A", ["action 1", "action 2"], "explanation A", 0.8,
        1, "test passed"
    )

    iteration = run_store.get_hilt_iteration("run_1", "anomaly_001", 1)
    assert iteration is not None
    assert iteration["iteration"] == 1
    assert iteration["llm_root_cause"] == "root cause A"
    assert iteration["llm_actions"] == ["action 1", "action 2"]
    assert iteration["llm_explanation"] == "explanation A"
    assert iteration["llm_confidence"] == 0.8
    assert iteration["test_pass"] is True
    assert iteration["test_comment"] == "test passed"

    assert run_store.get_hilt_iteration("run_1", "anomaly_001", 999) is None
    assert run_store.get_hilt_iteration("other", "anomaly_001", 1) is None


def test_list_hilt_iterations_ordered(monkeypatch, tmp_path) -> None:
    run_store.save_hilt_iteration("run_1", "anomaly_001", 3, "c", [], "c", 0.7, 0, None)
    run_store.save_hilt_iteration("run_1", "anomaly_001", 1, "a", [], "a", 0.9, 1, "ok")
    run_store.save_hilt_iteration("run_1", "anomaly_001", 2, "b", [], "b", 0.8, 0, "fail")

    iterations = run_store.list_hilt_iterations("run_1", "anomaly_001")
    assert len(iterations) == 3
    assert [it["iteration"] for it in iterations] == [1, 2, 3]
    assert iterations[0]["llm_root_cause"] == "a"
    assert iterations[1]["llm_root_cause"] == "b"
    assert iterations[2]["llm_root_cause"] == "c"


def test_hilt_iterations_persist_after_save(monkeypatch, tmp_path) -> None:
    run_store.save_hilt_iteration("run_1", "anomaly_001", 1, "cause", ["act"], "exp", 0.8, 1, "comment")
    run_store.save_hilt_iteration("run_1", "anomaly_001", 2, "cause2", ["act2"], "exp2", 0.7, 0, "comment2")

    # New connection (simulated by calling list again)
    iterations = run_store.list_hilt_iterations("run_1", "anomaly_001")
    assert len(iterations) == 2
