"""Iterative Debug Loop for HILT (Human-in-the-Loop Testing).

Implements the LLM Suggestion -> Engineer Test -> Feedback -> LLM Refine loop
with trigger-based escalation to expert review.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

import httpx

from src.config import get_settings
from src.models.schemas import AIResultSummary, EvidenceItem
from src.services import run_store
from src.services.hilt_triggers import HiltTriggerEvaluator
from src.services.llm import explain_diagnostics
from src.services.analysis import _canned_ai_results

logger = logging.getLogger(__name__)


class IterativeDebugger:
    """Stateful iterative debugger bound to one (run_id, anomaly_id)."""

    def __init__(
        self,
        run_id: str,
        anomaly_id: str,
        anomaly: dict[str, Any],
        model: str = "llm-explain",
    ) -> None:
        self.run_id = run_id
        self.anomaly_id = anomaly_id
        self.anomaly = anomaly
        self.model = model
        self.settings = get_settings()
        self._trigger_evaluator = HiltTriggerEvaluator(run_id, anomaly_id)

    def suggest(self, feedback_history: list[dict[str, Any]] | None = None) -> AIResultSummary:
        """Generate LLM suggestion with accumulated feedback history.

        Args:
            feedback_history: List of previous iteration feedback records.

        Returns:
            AIResultSummary with root_cause, recommended_actions, explanation, confidence.
        """
        summary = self._build_summary(feedback_history)
        try:
            explanation = explain_diagnostics(summary)
            return self._build_ai_result(explanation)
        # Only upstream/config failures are a legitimate reason to fall back. A
        # bare `except Exception` here silently swallowed an AttributeError in
        # result-building, so every call returned a canned answer while the LLM
        # was answering correctly and the feature looked merely "unreliable".
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "iterative_debug.llm_failed",
                extra={
                    "diagnostics": {
                        "event": "iterative_debug.llm_failed",
                        "level": "warning",
                        "details": {"run_id": self.run_id, "anomaly_id": self.anomaly_id, "error": str(exc)},
                    }
                },
            )
            return self._canned_result()

    def record_test(
        self,
        iteration: int,
        llm_root_cause: str,
        llm_actions: list[str],
        llm_explanation: str,
        llm_confidence: float,
        test_pass: bool,
        test_comment: str | None = None,
    ) -> None:
        """Record an iteration's test result to SQLite.

        Args:
            iteration: Iteration number (1-based).
            llm_root_cause: LLM's root cause text.
            llm_actions: LLM's recommended actions list.
            llm_explanation: LLM's full explanation text.
            llm_confidence: LLM's confidence score.
            test_pass: Whether engineer test passed.
            test_comment: Optional engineer comment.
        """
        run_store.save_hilt_iteration(
            self.run_id,
            self.anomaly_id,
            iteration,
            llm_root_cause,
            llm_actions,
            llm_explanation,
            llm_confidence,
            1 if test_pass else 0,
            test_comment,
        )

    def evaluate_triggers(self, current_llm_output: dict[str, Any]) -> list[str]:
        """Evaluate all HILT triggers for the current iteration.

        Args:
            current_llm_output: Dict with root_cause, explanation, confidence.

        Returns:
            List of triggered reason codes.
        """
        return self._trigger_evaluator.evaluate_all(current_llm_output)

    def should_continue(self, iteration: int, triggers: list[str]) -> bool:
        """Determine if the debug loop should continue.

        Args:
            iteration: Current iteration number.
            triggers: List of triggered reason codes from evaluate_triggers.

        Returns:
            True if loop should continue, False if should stop/escalate.
        """
        if triggers:
            return False
        return iteration < self.settings.hilt_max_iterations

    def build_hilt_payload(self, trigger_reasons: list[str]) -> dict[str, Any]:
        """Build summary JSON payload for expert review.

        Args:
            trigger_reasons: List of triggered reason codes.

        Returns:
            Summary payload dict.
        """
        iterations = run_store.list_hilt_iterations(self.run_id, self.anomaly_id)
        detections = run_store.get_run_anomalies(self.run_id)
        failure_count = sum(1 for it in iterations if not it["test_pass"])

        diagnostic_summary = {
            "total_detections": len(detections),
            "severity": self._compute_worst_severity(detections),
            "detections": detections,
            "thresholds": {},
        }

        return {
            "run_id": self.run_id,
            "anomaly_id": self.anomaly_id,
            "triggered_at": datetime.now(UTC).isoformat(),
            "trigger_reasons": trigger_reasons,
            "iterations": [
                {
                    "iteration": it["iteration"],
                    "timestamp": it["created_at"],
                    "llm_output": {
                        "root_cause": it["llm_root_cause"],
                        "recommended_actions": it["llm_actions"],
                        "explanation": it["llm_explanation"],
                        "confidence": it["llm_confidence"],
                    },
                    "engineer_feedback": {
                        "test_pass": it["test_pass"],
                        "comment": it["test_comment"],
                    },
                }
                for it in iterations
            ],
            "diagnostic_summary": diagnostic_summary,
            "failure_count": failure_count,
        }

    def _build_summary(self, feedback_history: list[dict[str, Any]] | None) -> dict[str, Any]:
        """Build diagnostics summary for LLM prompt."""
        detections = [self.anomaly]
        if feedback_history:
            feedback_lines = []
            for fb in feedback_history:
                fb_text = f"Iteration {fb['iteration']}: "
                if fb["test_pass"]:
                    fb_text += f"PASS - {fb['comment'] or 'No comment'}"
                else:
                    fb_text += f"FAIL - {fb['comment'] or 'No comment'}"
                feedback_lines.append(fb_text)
            detections.append({
                "kind": "feedback_history",
                "topic": "hilt/feedback",
                "severity": "info",
                "confidence": 1.0,
                "evidence": {"feedback": "\n".join(feedback_lines)},
            })
        return {
            "summary": {
                "total_detections": len(detections),
                "severity": self._compute_worst_severity([self.anomaly]),
            },
            "detections": detections,
        }

    def _build_ai_result(self, explanation: dict[str, str | list[str]]) -> AIResultSummary:
        """Convert LLM explanation to AIResultSummary."""
        topic = self.anomaly.get("topic", "/unknown")
        t_sec = float(self.anomaly.get("tSec", 0.0))
        detail = str(explanation.get("explanation", ""))
        return AIResultSummary(
            id=f"ai_{self.anomaly_id}",
            runId=self.run_id,
            anomalyId=self.anomaly_id,
            issue=str(explanation.get("root_cause", "")),
            rootCause=str(explanation.get("root_cause", "")),
            confidence=float(self.anomaly.get("confidence", 0.5)),
            explanation=detail,
            suggestedFix=[str(a) for a in explanation.get("recommended_actions", [])],
            evidence=[EvidenceItem(topic=topic, tSec=t_sec, detail=detail)],
            reviewStatus="pending",
            model=self.model,
            latencyMs=0,
            promptTokens=0,
            completionTokens=0,
            llmRequestId=f"llm_req_{self.anomaly_id}",
        )

    def _canned_result(self) -> AIResultSummary:
        """Fallback to canned AI result."""
        results = _canned_ai_results(self.run_id, [self.anomaly])
        return results[0] if results else AIResultSummary(
            id=f"ai_{self.anomaly_id}",
            runId=self.run_id,
            anomalyId=self.anomaly_id,
            issue="unknown",
            rootCause="unknown",
            confidence=0.0,
            explanation="LLM unavailable, no canned result",
            suggestedFix=[],
            evidence=[],
            reviewStatus="pending",
            model="canned-fallback",
            latencyMs=0,
            promptTokens=0,
            completionTokens=0,
            llmRequestId="llm_req_fallback",
        )

    def _compute_worst_severity(self, detections: list[dict[str, Any]]) -> str:
        """Compute worst severity from detections."""
        severity_rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
        if not detections:
            return "low"
        return max(
            (str(d.get("severity", "low")) for d in detections),
            key=lambda s: severity_rank.get(s, 0),
        )


def run_iterative_debug_loop(
    run_id: str,
    anomaly_id: str,
    anomaly: dict[str, Any],
    max_iterations: int | None = None,
) -> dict[str, Any]:
    """Run the full iterative debug loop until completion or escalation.

    NOTE: this batch entry point records a **placeholder** engineer verdict
    (``test_pass=False``, ``"awaiting engineer test"``) on every iteration —
    there is no human in this loop. It exists to exercise the trigger/escalation
    logic end to end. The interactive path where a real verdict is supplied is
    ``POST /api/v1/hilt/iterate`` (``routes.hilt_iterate``), which passes the
    engineer's ``test_pass``/``test_comment`` straight into ``record_test``.

    Args:
        run_id: Analysis run ID.
        anomaly_id: Anomaly ID to debug.
        anomaly: Anomaly detection dict.
        max_iterations: Optional override for max iterations.

    Returns:
        Dict with final status, iterations, and optional hilt_payload.
    """
    settings = get_settings()
    max_iter = max_iterations or settings.hilt_max_iterations

    debugger = IterativeDebugger(run_id, anomaly_id, anomaly)
    feedback_history: list[dict[str, Any]] = []

    for iteration in range(1, max_iter + 1):
        ai_result = debugger.suggest(feedback_history)

        llm_output = {
            "root_cause": ai_result.rootCause,
            "explanation": ai_result.explanation,
            "confidence": ai_result.confidence,
        }

        triggers = debugger.evaluate_triggers(llm_output)

        # In real usage, this would wait for engineer test input
        # For now, record a placeholder iteration
        debugger.record_test(
            iteration=iteration,
            llm_root_cause=ai_result.rootCause,
            llm_actions=ai_result.suggestedFix,
            llm_explanation=ai_result.explanation,
            llm_confidence=ai_result.confidence,
            test_pass=False,  # Placeholder - real implementation waits for input
            test_comment="awaiting engineer test",
        )

        feedback_history.append({
            "iteration": iteration,
            "test_pass": False,
            "comment": "awaiting engineer test",
        })

        if not debugger.should_continue(iteration, triggers):
            hilt_payload = debugger.build_hilt_payload(triggers)
            return {
                "status": "escalated" if triggers else "max_iterations",
                "iterations": iteration,
                "triggers": triggers,
                "hilt_payload": hilt_payload,
            }

    return {
        "status": "completed",
        "iterations": max_iter,
        "triggers": [],
        "hilt_payload": None,
    }
