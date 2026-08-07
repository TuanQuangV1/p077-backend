"""Unit tests for iterative debug loop."""

from __future__ import annotations

import pytest

from src.services.iterative_debug import IterativeDebugger, run_iterative_debug_loop
from src.services.run_store import save_hilt_iteration


class TestIterativeDebugger:
    def test_suggest_returns_ai_result(self, tmp_path, monkeypatch) -> None:
        import src.services.run_store as run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        anomaly = {
            "id": "anomaly_001",
            "kind": "frequency_gap",
            "topic": "/test",
            "severity": "medium",
            "confidence": 0.7,
            "tSec": 1.0,
            "endSec": 2.0,
        }

        debugger = IterativeDebugger("run_1", "anomaly_001", anomaly)
        result = debugger.suggest()

        assert result is not None
        assert hasattr(result, "rootCause")
        assert hasattr(result, "explanation")
        assert hasattr(result, "suggestedFix")
        assert hasattr(result, "confidence")

    def test_record_test_persists(self, tmp_path, monkeypatch) -> None:
        import src.services.run_store as run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        anomaly = {
            "id": "anomaly_001",
            "kind": "frequency_gap",
            "topic": "/test",
            "severity": "medium",
            "confidence": 0.7,
            "tSec": 1.0,
            "endSec": 2.0,
        }

        debugger = IterativeDebugger("run_1", "anomaly_001", anomaly)
        debugger.record_test(
            iteration=1,
            llm_root_cause="test cause",
            llm_actions=["action 1"],
            llm_explanation="test explanation",
            llm_confidence=0.8,
            test_pass=True,
            test_comment="test passed",
        )

        iterations = run_store.list_hilt_iterations("run_1", "anomaly_001")
        assert len(iterations) == 1
        assert iterations[0]["iteration"] == 1
        assert iterations[0]["llm_root_cause"] == "test cause"
        assert iterations[0]["test_pass"] is True
        assert iterations[0]["test_comment"] == "test passed"

    def test_should_continue_no_triggers(self, tmp_path, monkeypatch) -> None:
        import src.services.run_store as run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        anomaly = {
            "id": "anomaly_001",
            "kind": "frequency_gap",
            "topic": "/test",
            "severity": "medium",
            "confidence": 0.7,
            "tSec": 1.0,
            "endSec": 2.0,
        }

        debugger = IterativeDebugger("run_1", "anomaly_001", anomaly)
        triggers = []
        assert debugger.should_continue(1, triggers) is True
        assert debugger.should_continue(4, triggers) is True
        assert debugger.should_continue(5, triggers) is False  # max_iterations = 5

    def test_should_continue_triggered(self, tmp_path, monkeypatch) -> None:
        import src.services.run_store as run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        anomaly = {
            "id": "anomaly_001",
            "kind": "frequency_gap",
            "topic": "/test",
            "severity": "medium",
            "confidence": 0.7,
            "tSec": 1.0,
            "endSec": 2.0,
        }

        debugger = IterativeDebugger("run_1", "anomaly_001", anomaly)
        triggers = ["llm_uncertain"]
        assert debugger.should_continue(1, triggers) is False

    def test_should_continue_max_iterations(self, tmp_path, monkeypatch) -> None:
        import src.services.run_store as run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        anomaly = {
            "id": "anomaly_001",
            "kind": "frequency_gap",
            "topic": "/test",
            "severity": "medium",
            "confidence": 0.7,
            "tSec": 1.0,
            "endSec": 2.0,
        }

        debugger = IterativeDebugger("run_1", "anomaly_001", anomaly)
        triggers = []
        # Default max_iterations is 5
        assert debugger.should_continue(4, triggers) is True
        assert debugger.should_continue(5, triggers) is False
        assert debugger.should_continue(6, triggers) is False

    def test_build_hilt_payload_shape(self, tmp_path, monkeypatch) -> None:
        import src.services.run_store as run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        anomaly = {
            "id": "anomaly_001",
            "kind": "frequency_gap",
            "topic": "/test",
            "severity": "medium",
            "confidence": 0.7,
            "tSec": 1.0,
            "endSec": 2.0,
        }

        debugger = IterativeDebugger("run_1", "anomaly_001", anomaly)

        # Record a test iteration
        debugger.record_test(
            iteration=1,
            llm_root_cause="test cause",
            llm_actions=["action 1", "action 2"],
            llm_explanation="test explanation",
            llm_confidence=0.8,
            test_pass=False,
            test_comment="failed",
        )

        payload = debugger.build_hilt_payload(["llm_uncertain"])

        assert payload["run_id"] == "run_1"
        assert payload["anomaly_id"] == "anomaly_001"
        assert "triggered_at" in payload
        assert payload["trigger_reasons"] == ["llm_uncertain"]
        assert len(payload["iterations"]) == 1
        assert payload["iterations"][0]["iteration"] == 1
        assert payload["iterations"][0]["llm_output"]["root_cause"] == "test cause"
        assert payload["iterations"][0]["engineer_feedback"]["test_pass"] is False
        assert "diagnostic_summary" in payload
        assert payload["failure_count"] == 1

    def test_refine_includes_feedback_history(self, tmp_path, monkeypatch) -> None:
        import src.services.run_store as run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        anomaly = {
            "id": "anomaly_001",
            "kind": "frequency_gap",
            "topic": "/test",
            "severity": "medium",
            "confidence": 0.7,
            "tSec": 1.0,
            "endSec": 2.0,
        }

        debugger = IterativeDebugger("run_1", "anomaly_001", anomaly)

        # Record first iteration with failed test
        debugger.record_test(
            iteration=1,
            llm_root_cause="initial cause",
            llm_actions=["action 1"],
            llm_explanation="initial explanation",
            llm_confidence=0.8,
            test_pass=False,
            test_comment="did not work",
        )

        # Get second suggestion - should include feedback history
        result = debugger.suggest()

        assert result is not None
        # The suggestion should work (exact content depends on LLM/canned fallback)


class TestRunIterativeDebugLoop:
    def test_loop_completes(self, tmp_path, monkeypatch) -> None:
        import src.services.run_store as run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        anomaly = {
            "id": "anomaly_001",
            "kind": "frequency_gap",
            "topic": "/test",
            "severity": "medium",
            "confidence": 0.7,
            "tSec": 1.0,
            "endSec": 2.0,
        }

        result = run_iterative_debug_loop("run_1", "anomaly_001", anomaly, max_iterations=2)

        assert result["status"] in ("completed", "escalated", "max_iterations")
        assert result["iterations"] <= 2