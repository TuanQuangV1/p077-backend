"""Shared analysis pipeline used by both the API and the CLI.

Both interfaces execute the exact same flow: locate the dataset bag, run the
rule-based diagnostics, build AI explanations (real LLM when a vLLM backend is
configured, deterministic canned text otherwise), persist the run, detections,
AI results and review queue in SQLite, then return the assembled payload.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from datetime import UTC, datetime
from itertools import chain
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

from src.config import get_settings
from src.models.schemas import AIResultSummary, AnalysisRun, EvidenceItem
from src.services import run_store
from src.services.bag_stream import iter_bag_messages
from src.services.diagnostics import detect_anomalies
from src.services.experiments import experiment_bag_files, list_experiments
from src.services.health import compute_health_summary
from src.services.llm import explain_diagnostics, is_llm_configured

logger = logging.getLogger(__name__)

_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}

_KIND_TITLES = {
    "frequency_gap": "Publish gap on {topic}",
    "message_drop_burst": "Message drop burst on {topic}",
    "timestamp_jitter": "Timestamp jitter on {topic}",
    "silent_node": "Silent node {node}",
    "clock_drift": "Clock drift on {topic}",
    "hz_drop": "Publish rate drop on {topic}",
    "hz_drop_critical": "Severe publish rate drop on {topic}",
    "header_latency": "Header latency on {topic}",
    "log_fatal": "Fatal log on {topic}",
    "log_error_burst": "Error burst on {topic}",
    "log_warn_storm": "Warning storm on {topic}",
    "payload_zero_byte": "Empty payload on {topic}",
    "tf_missing_gap": "TF broadcast gap on {topic}",
    "tf_drift_jump": "TF frame re-parenting on {topic}",
}

_KIND_LABELS = {
    "frequency_gap": "Topic rate drop",
    "message_drop_burst": "Message drop burst",
    "timestamp_jitter": "Timestamp jitter",
    "silent_node": "Silent node",
    "clock_drift": "Clock drift",
    "hz_drop": "Publish rate drop",
    "hz_drop_critical": "Severe rate drop",
    "header_latency": "Header latency",
    "log_fatal": "Fatal log",
    "log_error_burst": "Log error burst",
    "log_warn_storm": "Log warning storm",
    "payload_zero_byte": "Empty sensor payload",
    "tf_missing_gap": "TF broadcast gap",
    "tf_drift_jump": "TF frame jump",
}

_DEFAULT_MODEL = "vllm/qwen2.5-coder-32b"


def _pending_run_from_dataset(ds: Mapping[str, Any], model: str) -> AnalysisRun:
    """Build a pending AnalysisRun bound to a specific dataset (nothing parsed yet)."""
    now = datetime.now(UTC).isoformat()
    return AnalysisRun(
        id=f"run_{ds['id']}",
        rosbagId=ds["id"],
        rosbagName=ds["name"],
        robotType=ds["robotType"],
        status="uploaded",
        progress=0,
        stage="parse",
        startedAt=now,
        finishedAt=None,
        anomalyCount=0,
        worstSeverity=None,
        model=model,
        totalLatencyMs=0,
        promptTokens=0,
        completionTokens=0,
        costUsd=0.0,
    )


def _failed_run(
    ds: Mapping[str, Any],
    model: str,
    started_at: str,
    started: float,
) -> AnalysisRun:
    return AnalysisRun(
        id=f"run_{ds['id']}",
        rosbagId=ds["id"],
        rosbagName=ds["name"],
        robotType=ds["robotType"],
        status="failed",
        progress=0,
        stage="parse",
        startedAt=started_at,
        finishedAt=datetime.now(UTC).isoformat(),
        anomalyCount=0,
        worstSeverity=None,
        model=model,
        totalLatencyMs=int((time.perf_counter() - started) * 1000),
        promptTokens=0,
        completionTokens=0,
        costUsd=0.0,
    )


def _succeeded_run(
    ds: Mapping[str, Any],
    model: str,
    started_at: str,
    started: float,
    detections: list[dict[str, Any]],
) -> AnalysisRun:
    worst = None
    if detections:
        worst = max(
            (str(d.get("severity", "low")) for d in detections),
            key=lambda s: _SEVERITY_RANK.get(s, 0),
        )
    return AnalysisRun(
        id=f"run_{ds['id']}",
        rosbagId=ds["id"],
        rosbagName=ds["name"],
        robotType=ds["robotType"],
        status="succeeded",
        progress=100,
        stage="done",
        startedAt=started_at,
        finishedAt=datetime.now(UTC).isoformat(),
        anomalyCount=len(detections),
        worstSeverity=worst,
        model=model,
        totalLatencyMs=int((time.perf_counter() - started) * 1000),
        promptTokens=0,
        completionTokens=0,
        costUsd=0.0,
    )


def _anomaly_summaries(run_id: str, detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert raw detection dicts into the AnomalySummary response shape."""
    summaries = []
    for index, detection in enumerate(detections, start=1):
        kind = detection.get("kind", "unknown")
        topic = detection.get("topic", "/unknown")
        evidence = detection.get("evidence", {})
        title = _KIND_TITLES.get(kind, "Anomaly on {topic}").format(
            topic=topic,
            node=evidence.get("node", "unknown"),
        )
        metric_parts = []
        for key in (
            "interval_sec",
            "active_span_sec",
            "max_gap_sec",
            "jitter_sec",
            "drift_sec",
            "threshold_sec",
        ):
            if key in evidence:
                metric_parts.append(f"{key.replace('_', ' ')} {evidence[key]}")
        summaries.append(
            {
                "id": f"anomaly_{index:03d}",
                "runId": run_id,
                "kind": kind,
                "title": title,
                "severity": detection.get("severity", "low"),
                "tSec": float(detection.get("tSec", 0.0)),
                "endSec": float(detection.get("endSec", 0.0)),
                "topics": [topic],
                "confidence": float(detection.get("confidence", 0.5)),
                "metric": "; ".join(metric_parts) or f"detected on {topic}",
            }
        )
    return summaries


def _canned_ai_results(run_id: str, detections: list[dict[str, Any]]) -> list[AIResultSummary]:
    """Build deterministic AI results from real detections until live inference is wired up.

    Canned explanations are routed through :func:`_ai_result_from_explanation` so the
    fallback output shares the exact same shape as the real LLM path.
    """
    results = []
    for index, detection in enumerate(detections, start=1):
        kind = detection.get("kind", "unknown")
        topic = detection.get("topic", "/unknown")
        canned = {
            "frequency_gap": (
                f"Frequent publish gap detected on {topic}.",
                "Producer thread starvation or transport buffering paused publishing.",
                f"Message flow on {topic} stalled for the detected window.",
            ),
            "message_drop_burst": (
                f"Burst of dropped messages detected on {topic}.",
                "A single long inter-message interval indicates dropped or coalesced messages.",
                f"Messages on {topic} were missing for the detected interval.",
            ),
            "timestamp_jitter": (
                f"Timestamp jitter detected on {topic}.",
                "Publish cadence deviates more than expected from the nominal rate.",
                f"Inter-message intervals on {topic} show higher variance than the threshold.",
            ),
            "silent_node": (
                f"Node silence detected for topic {topic}.",
                "The node stopped publishing for the full observation window.",
                f"No messages were observed on {topic} during the span.",
            ),
            "clock_drift": (
                f"Clock drift detected on {topic}.",
                "Message header stamps drift from the bag recording timestamps.",
                f"Header-vs-bag timestamp offset on {topic} exceeded the tolerance.",
            ),
            "unknown": (
                f"Anomaly pattern detected on {topic}.",
                "Raw signal deviates from the expected cadence.",
                f"Diagnostics flagged {topic} with the reported evidence.",
            ),
        }
        issue, root_cause, _ = canned.get(kind, canned["unknown"])
        explanation: dict[str, str | list[str]] = {
            "root_cause": root_cause,
            "recommended_actions": [
                "Check the producing node for publish stalls or thread starvation.",
                "Validate the network / recorder path for bursty or dropped message windows.",
            ],
            "explanation": f"{issue} {root_cause}",
        }
        results.append(_ai_result_from_explanation(run_id, index, detection, explanation, model="canned-fallback"))
    return results


def _ai_result_from_explanation(
    run_id: str,
    index: int,
    detection: dict[str, Any],
    explanation: dict[str, str | list[str]],
    model: str = "llm-explain",
) -> AIResultSummary:
    topic = detection.get("topic", "/unknown")
    t_sec = float(detection.get("tSec", 0.0))
    detail = str(explanation.get("explanation", ""))
    return AIResultSummary(
        id=f"ai_{index:03d}",
        runId=run_id,
        anomalyId=f"anomaly_{index:03d}",
        issue=str(explanation.get("root_cause", "")),
        rootCause=str(explanation.get("root_cause", "")),
        confidence=float(detection.get("confidence", 0.5)),
        explanation=str(explanation.get("explanation", "")),
        suggestedFix=[str(a) for a in explanation.get("recommended_actions", [])],
        evidence=[EvidenceItem(topic=topic, tSec=t_sec, detail=detail)],
        reviewStatus="pending",
        model=model,
        latencyMs=0,
        promptTokens=0,
        completionTokens=0,
        vllmRequestId=f"vllm_req_{index:03d}",
    )


def _build_ai_results(run_id: str, detections: list[dict[str, Any]]) -> list[AIResultSummary]:
    """Produce AI results per detection, using the LLM when a vLLM backend is configured.

    Falls back to deterministic canned results when the LLM is unavailable or
    a per-detection call fails, so an analysis run never fails on inference.
    """
    settings = get_settings()
    use_llm = settings.llm_provider == "vllm" and is_llm_configured()
    if not use_llm or not detections:
        return _canned_ai_results(run_id, detections)

    results: list[AIResultSummary] = []
    for index, detection in enumerate(detections, start=1):
        try:
            explanation = explain_diagnostics(
                {
                    "summary": {
                        "total_detections": 1,
                        "severity": detection.get("severity", "low"),
                    },
                    "detections": [detection],
                }
            )
            results.append(_ai_result_from_explanation(run_id, index, detection, explanation))
        except Exception:
            logger.warning(
                "analysis.ai_fallback",
                extra={
                    "diagnostics": {
                        "event": "analysis.ai_fallback",
                        "level": "warning",
                        "details": {"run_id": run_id},
                    }
                },
            )
            results.append(_canned_ai_results(run_id, [detection])[0])
    return results


def _persist_review_items(run: AnalysisRun, ai_results: list[AIResultSummary]) -> None:
    run_store.save_review_items(
        [
            {
                "id": f"review_{run.id}_{index:03d}",
                "runId": run.id,
                "anomalyId": result.anomalyId,
                "reviewStatus": result.reviewStatus,
                "rootCause": result.rootCause,
                "explanation": result.explanation,
            }
            for index, result in enumerate(ai_results, start=1)
        ]
    )


def run_analysis(dataset_id: str, model: str | None = None) -> dict[str, Any]:
    """Run the full analysis pipeline for a dataset and persist its results.

    Locates the dataset bag files, streams them through the rule-based
    diagnostics, builds AI explanations, then persists the run, detections,
    AI results and review items via :mod:`src.services.run_store`.

    Args:
        dataset_id: ID of the dataset (folder name under ``data/``) to analyze.
        model: Optional model label recorded on the run.

    Returns:
        Dict with ``run`` (``AnalysisRun``), ``detections`` (raw detection
        dicts), ``ai_results`` (``AIResultSummary`` list) and ``health``
        (the Health Summary JSON).

    Raises:
        ValueError: No dataset with the given id exists.
    """
    ds = next((d for d in list_experiments() if d["id"] == dataset_id), None)
    if ds is None:
        raise ValueError(f"dataset not found: {dataset_id}")

    started_at = datetime.now(UTC).isoformat()
    started = time.perf_counter()
    resolved_model = model or _DEFAULT_MODEL

    bag_files = experiment_bag_files(dataset_id)
    if not bag_files:
        run = _pending_run_from_dataset(ds, resolved_model)
        detections: list[dict[str, Any]] = []
        total_messages = 0
    else:
        try:
            stream = chain.from_iterable(iter_bag_messages(bag_path) for bag_path in bag_files)
            analysis_result = detect_anomalies(stream, None)
            detections = analysis_result.get("detections", [])
            total_messages = int(analysis_result.get("summary", {}).get("total_messages", 0))
            run = _succeeded_run(ds, resolved_model, started_at, started, detections)
        except (sqlite3.DatabaseError, OSError, ValueError) as exc:
            logger.warning(
                "analysis.parse_failed",
                extra={
                    "diagnostics": {
                        "event": "analysis.parse_failed",
                        "level": "warning",
                        "details": {"id": ds["id"], "error": str(exc)},
                    }
                },
            )
            run = _failed_run(ds, resolved_model, started_at, started)
            detections = []
            total_messages = 0

    ai_results = _build_ai_results(run.id, detections)
    report_health = compute_health_summary(detections, total_messages=total_messages)
    run_store.save_run(run.model_dump())
    run_store.save_run_anomalies(run.id, detections)
    run_store.save_run_ai_results(run.id, [result.model_dump() for result in ai_results])
    _persist_review_items(run, ai_results)

    logger.info(
        "analysis.created",
        extra={
            "diagnostics": {
                "event": "analysis.created",
                "level": "info",
                "details": {"id": run.id, "status": run.status, "anomalyCount": run.anomalyCount},
            }
        },
    )
    return {
        "run": run,
        "detections": detections,
        "ai_results": ai_results,
        "health": report_health,
    }
