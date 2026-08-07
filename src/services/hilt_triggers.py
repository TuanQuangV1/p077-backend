"""HILT (Human-in-the-Loop Testing) trigger detection.

Detects three conditions that should escalate an iterative debug session to
expert review:
1. LLM uncertainty (low confidence or hedging language)
2. LLM looping (repeating similar outputs across iterations)
3. User failure accumulation (repeated negative feedback)
"""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from src.config import get_settings
from src.services import run_store
from src.services.hilt_store import list_hilt_reviews

_UNCERTAINTY_PATTERNS = [
    r"\bcould be\b",
    r"\bmight be\b",
    r"\bmay be\b",
    r"\bmight\b",
    r"\bpossibly\b",
    r"\bperhaps\b",
    r"\bseems to\b",
    r"\blooks like\b",
    r"\beither\b.*\bor\b",
    r"\bone (possible|possible cause)\b",
    r"\bseveral\b",
    r"\bmultiple\b",
    r"\bamoung the\b",
    r"\buncertain\b",
    r"\bnot sure\b",
    r"\bnot certain\b",
    r"\bseveral possibilities\b",
    r"\bseveral likely\b",
]

HiltTriggerReason = str


def detect_llm_uncertainty(text: str, confidence: float | None = None) -> float:
    """Calculate uncertainty score from LLM output text and confidence value.

    Args:
        text: Combined root_cause + explanation text from LLM output.
        confidence: Optional confidence value from AIResultSummary (0-1).

    Returns:
        Uncertainty score in range [0.0, 1.0].
    """
    settings = get_settings()
    text_lower = text.lower()
    matches = sum(1 for pattern in _UNCERTAINTY_PATTERNS if re.search(pattern, text_lower))
    regex_score = min(matches / 3.0, 1.0)

    confidence_penalty = 0.0
    if confidence is not None:
        if confidence < settings.hilt_uncertainty_threshold:
            confidence_penalty = 0.3

    return min(regex_score + confidence_penalty, 1.0)


def detect_llm_loop(
    run_id: str,
    anomaly_id: str,
    current_output: str,
    min_iterations: int = 2,
) -> bool:
    """Check if current LLM output is too similar to previous iterations.

    Args:
        run_id: Analysis run ID.
        anomaly_id: Anomaly ID within the run.
        current_output: Combined root_cause + explanation text from current iteration.
        min_iterations: Minimum previous iterations required before loop detection activates.

    Returns:
        True if a loop is detected, False otherwise.
    """
    settings = get_settings()
    prev_iterations = run_store.list_hilt_iterations(run_id, anomaly_id)
    if len(prev_iterations) < min_iterations:
        return False

    for prev in prev_iterations:
        prev_output = prev["llm_root_cause"] + " " + prev["llm_explanation"]
        ratio = SequenceMatcher(None, current_output, prev_output).ratio()
        if ratio > settings.hilt_loop_similarity_threshold:
            return True
    return False


def count_user_failures(run_id: str) -> int:
    """Count negative feedback from both HILT JSONL and SQLite review items.

    Args:
        run_id: Analysis run ID.

    Returns:
        Total count of 'wrong', 'partial' (HILT) and 'rejected' (review items) labels.
    """
    hilt_reviews = list_hilt_reviews(run_id)
    wrong_count = sum(1 for r in hilt_reviews if r.get("label") in ("wrong", "partial"))

    review_items = run_store.list_review_items()
    rejected_count = sum(
        1 for r in review_items if r.get("verdict") == "rejected" and r.get("runId") == run_id
    )

    return wrong_count + rejected_count


class HiltTriggerEvaluator:
    """Evaluates all HILT trigger conditions for a debug iteration."""

    def __init__(self, run_id: str, anomaly_id: str) -> None:
        self.run_id = run_id
        self.anomaly_id = anomaly_id

    def evaluate_all(self, current_llm_output: dict[str, Any]) -> list[HiltTriggerReason]:
        """Run all three trigger checks.

        Args:
            current_llm_output: Dict with keys root_cause, explanation, confidence.

        Returns:
            List of triggered reason codes: "llm_uncertain", "llm_looping", "user_failures".
        """
        settings = get_settings()
        triggers: list[HiltTriggerReason] = []

        combined_text = current_llm_output.get("root_cause", "") + " " + current_llm_output.get("explanation", "")
        confidence = current_llm_output.get("confidence")
        if confidence is None:
            confidence = 0.0

        # Trigger 1: LLM Uncertainty
        uncertainty_score = detect_llm_uncertainty(combined_text, confidence)
        if uncertainty_score > settings.hilt_uncertainty_threshold:
            triggers.append("llm_uncertain")

        # Trigger 2: LLM Loop Detection
        if detect_llm_loop(self.run_id, self.anomaly_id, combined_text):
            triggers.append("llm_looping")

        # Trigger 3: User Failure Count
        failure_count = count_user_failures(self.run_id)
        if failure_count >= settings.hilt_max_failures:
            triggers.append("user_failures")

        return triggers