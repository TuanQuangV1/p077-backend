"""Unit tests for HILT trigger detection."""

from __future__ import annotations


from src.services.hilt_triggers import (
    HiltTriggerEvaluator,
    count_user_failures,
    detect_llm_loop,
    detect_llm_uncertainty,
)


class TestDetectLlmUncertainty:
    def test_low_confidence_text(self) -> None:
        text = "could be A or B or C, might be several possibilities"
        score = detect_llm_uncertainty(text, confidence=0.9)
        assert score > 0.5

    def test_clean_text(self) -> None:
        text = "root cause is X"
        score = detect_llm_uncertainty(text, confidence=0.9)
        assert score == 0.0

    def test_confidence_boost(self) -> None:
        text = "root cause is X"
        score = detect_llm_uncertainty(text, confidence=0.3)  # Below default threshold 0.5
        assert score == 0.3  # Only confidence penalty applies

    def test_uncertainty_patterns_with_confidence(self) -> None:
        text = "could be A or B or C, might be several possibilities"
        score = detect_llm_uncertainty(text, confidence=0.3)
        # regex score (3 matches / 3 = 1.0) + confidence penalty (0.3) = 1.3, capped at 1.0
        assert score == 1.0


class TestDetectLlmLoop:
    def test_identical_output(self, tmp_path, monkeypatch) -> None:
        from src.services import run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        run_store.save_hilt_iteration(
            "run_1", "anomaly_001", 1, "root cause A", ["action 1"], "explanation A", 0.8, 0, "comment"
        )
        run_store.save_hilt_iteration(
            "run_1", "anomaly_001", 2, "root cause A", ["action 1"], "explanation A", 0.8, 0, "comment"
        )

        current = "root cause A explanation A"
        assert detect_llm_loop("run_1", "anomaly_001", current) is True

    def test_different_output(self, tmp_path, monkeypatch) -> None:
        from src.services import run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        run_store.save_hilt_iteration(
            "run_1", "anomaly_001", 1, "root cause A", ["action 1"], "explanation A", 0.8, 0, "comment"
        )
        run_store.save_hilt_iteration(
            "run_1", "anomaly_001", 2, "completely different issue B", ["action 2"], "very different explanation B", 0.7, 0, "comment"
        )

        current = "totally unrelated cause C with different explanation C"
        assert detect_llm_loop("run_1", "anomaly_001", current) is False

    def test_below_min_iterations(self, tmp_path, monkeypatch) -> None:
        from src.services import run_store

        db_path = tmp_path / "test.db"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))

        run_store.save_hilt_iteration(
            "run_1", "anomaly_001", 1, "root cause A", ["action 1"], "explanation A", 0.8, 0, "comment"
        )

        current = "totally different cause C with different explanation C"
        # With min_iterations=2 (default), we need at least 2 previous iterations
        assert detect_llm_loop("run_1", "anomaly_001", current, min_iterations=2) is False


class TestCountUserFailures:
    def test_wrong_labels(self, tmp_path, monkeypatch) -> None:
        from src.services import hilt_store
        from src.services import run_store

        db_path = tmp_path / "test.db"
        hilt_dir = tmp_path / "hilt"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))
        monkeypatch.setenv("HILT_DIR", str(hilt_dir))

        # HILT JSONL feedback
        hilt_store.append_hilt_review("run_1", {"prediction": "test", "label": "wrong", "comment": ""})
        hilt_store.append_hilt_review("run_1", {"prediction": "test", "label": "wrong", "comment": ""})
        hilt_store.append_hilt_review("run_1", {"prediction": "test", "label": "partial", "comment": ""})

        # SQLite review items
        run_store.save_review_items([
            {"id": "review_1", "runId": "run_1", "anomalyId": "anomaly_001", "reviewStatus": "done", "rootCause": "a", "explanation": "b"},
        ])
        run_store.update_review_item("review_1", "rejected", "reviewer", "notes")

        count = count_user_failures("run_1")
        assert count == 4  # 2 wrong + 1 partial (HILT) + 1 rejected (review items)

    def test_no_feedback(self, tmp_path, monkeypatch) -> None:

        db_path = tmp_path / "test.db"
        hilt_dir = tmp_path / "hilt"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))
        monkeypatch.setenv("HILT_DIR", str(hilt_dir))

        count = count_user_failures("run_1")
        assert count == 0


class TestHiltTriggerEvaluator:
    def test_all_triggers(self, tmp_path, monkeypatch) -> None:
        from src.services import hilt_store
        from src.services import run_store

        db_path = tmp_path / "test.db"
        hilt_dir = tmp_path / "hilt"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))
        monkeypatch.setenv("HILT_DIR", str(hilt_dir))

        # Setup: 3 user failures (triggers user_failures at default threshold 3)
        hilt_store.append_hilt_review("run_1", {"prediction": "test", "label": "wrong", "comment": ""})
        hilt_store.append_hilt_review("run_1", {"prediction": "test", "label": "wrong", "comment": ""})
        hilt_store.append_hilt_review("run_1", {"prediction": "test", "label": "wrong", "comment": ""})

        # Setup: loop detection - need very similar outputs to exceed 0.85 threshold
        # Previous iterations have identical output
        run_store.save_hilt_iteration(
            "run_1", "anomaly_001", 1,
            "root cause could be several possibilities",
            ["action 1"],
            "explanation might be either this or that",
            0.4, 0, "comment"
        )
        run_store.save_hilt_iteration(
            "run_1", "anomaly_001", 2,
            "root cause could be several possibilities",
            ["action 1"],
            "explanation might be either this or that",
            0.4, 0, "comment"
        )

        evaluator = HiltTriggerEvaluator("run_1", "anomaly_001")
        # Current output nearly identical to previous to trigger loop detection
        # Also includes uncertainty patterns to trigger llm_uncertain
        current = {
            "root_cause": "root cause could be several possibilities",
            "explanation": "explanation might be either this or that",
            "confidence": 0.4,  # Below threshold
        }
        triggers = evaluator.evaluate_all(current)

        assert "llm_uncertain" in triggers
        assert "llm_looping" in triggers
        assert "user_failures" in triggers
        assert len(triggers) == 3

    def test_no_triggers(self, tmp_path, monkeypatch) -> None:
        from src.services import run_store

        db_path = tmp_path / "test.db"
        hilt_dir = tmp_path / "hilt"
        monkeypatch.setenv("RUN_DB_PATH", str(db_path))
        monkeypatch.setenv("HILT_DIR", str(hilt_dir))

        run_store.save_hilt_iteration(
            "run_1", "anomaly_001", 1, "root cause A", ["action 1"], "explanation A", 0.8, 0, "comment"
        )

        evaluator = HiltTriggerEvaluator("run_1", "anomaly_001")
        current = {
            "root_cause": "root cause is definitely X",
            "explanation": "the root cause is clearly X",
            "confidence": 0.9,
        }
        triggers = evaluator.evaluate_all(current)

        assert triggers == []
