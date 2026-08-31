"""Shared analysis pipeline used by both the API and the CLI.

Both interfaces execute the exact same flow: locate the dataset bag, run the
rule-based diagnostics, build AI explanations (real LLM when configured,
deterministic canned text otherwise), persist the run, detections,
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
from src.services import perf, run_store
from src.services.bag_stream import iter_bag_messages
from src.services.diagnostics import detect_anomalies
from src.services.experiments import experiment_bag_files, list_experiments
from src.services.health import compute_health_summary
from src.services.llm import (
    _ACTUATOR_LAYER,
    _compute_cost_usd,
    _topic_layer,
    explain_detection_cluster,
    is_llm_configured,
)

logger = logging.getLogger(__name__)

_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}

_KIND_TITLES_VI = {
    "frequency_gap": "Khoảng trống phát hành trên {topic}",
    "message_drop_burst": "Cụm mất gói tin trên {topic}",
    "timestamp_jitter": "Jitter dấu thời gian trên {topic}",
    "silent_node": "Node im lặng {node}",
    "clock_drift": "Trôi đồng hồ trên {topic}",
    "hz_drop": "Sụt tần suất phát trên {topic}",
    "hz_drop_critical": "Sụt tần suất nghiêm trọng trên {topic}",
    "header_latency": "Trễ header trên {topic}",
    "log_fatal": "Log fatal trên {topic}",
    "log_error_burst": "Cụm lỗi log trên {topic}",
    "log_warn_storm": "Bão cảnh báo log trên {topic}",
    "payload_zero_byte": "Payload rỗng trên {topic}",
    "payload_nan": "Nhiễu NaN trên {topic}",
    "payload_out_of_range": "Giá trị ngoài ngưỡng trên {topic}",
    "tf_missing_gap": "Khoảng trống TF trên {topic}",
    "tf_drift_jump": "Nhảy khung TF trên {topic}",
    "tf_conflict": "Xung đột phát hành TF trên {topic}",
}

_KIND_TITLES_EN = {
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
    "payload_nan": "NaN corruption on {topic}",
    "payload_out_of_range": "Out-of-range readings on {topic}",
    "tf_missing_gap": "TF broadcast gap on {topic}",
    "tf_drift_jump": "TF frame re-parenting on {topic}",
    "tf_conflict": "TF conflicting publishers on {topic}",
}

def _kind_titles() -> dict[str, str]:
    return _KIND_TITLES_VI if getattr(get_settings(), "llm_language", "vi") == "vi" else _KIND_TITLES_EN

# legacy alias for tests that import _KIND_TITLES
_KIND_TITLES = _KIND_TITLES_EN

_KIND_LABELS_VI = {
    "frequency_gap": "Sụt tần suất",
    "message_drop_burst": "Mất gói theo cụm",
    "timestamp_jitter": "Jitter timestamp",
    "silent_node": "Node im lặng",
    "clock_drift": "Trôi đồng hồ",
    "hz_drop": "Sụt tần suất",
    "hz_drop_critical": "Sụt tần suất nghiêm trọng",
    "header_latency": "Trễ header",
    "log_fatal": "Log fatal",
    "log_error_burst": "Cụm lỗi log",
    "log_warn_storm": "Bão cảnh báo",
    "payload_zero_byte": "Payload rỗng",
    "payload_nan": "Nhiễu NaN",
    "payload_out_of_range": "Giá trị ngoài ngưỡng",
    "tf_missing_gap": "Khoảng trống TF",
    "tf_drift_jump": "Nhảy TF",
    "tf_conflict": "Xung đột TF",
}

_KIND_LABELS_EN = {
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
    "payload_nan": "NaN sensor corruption",
    "payload_out_of_range": "Out-of-range sensor reading",
    "tf_missing_gap": "TF broadcast gap",
    "tf_drift_jump": "TF frame jump",
    "tf_conflict": "TF conflicting publishers",
}

def _kind_labels() -> dict[str, str]:
    return _KIND_LABELS_VI if getattr(get_settings(), "llm_language", "vi") == "vi" else _KIND_LABELS_EN

# legacy alias
_KIND_LABELS = _KIND_LABELS_EN

# Grace period allowed between a running incident's end and the next detection's
# start before they count as separate incidents. Zero: since clustering keys on
# span overlap (see `_cluster_detections`), propagation delay is already covered
# — a consumer that stalls while its cause is still active overlaps it by
# definition. Any grace on top only merges genuinely distinct faults that happen
# to fall a few seconds apart. Measured over 3 runs on 38 bags, dropping it from
# 5s lifted root-cause accuracy to 87.7-89.2% (from 85.7-87.5%) and per-fault
# diagnosis to 82.1-83.9% (from 78.6-80.4%) — neither range overlapping the old
# one — at the cost of 65 LLM calls instead of 56.
_CLUSTER_SLACK_SEC = 0.0


def _configured_model() -> str:
    """Return the model name of the provider actually in use."""
    settings = get_settings()
    if settings.llm_provider == "anthropic":
        return settings.anthropic_model_name
    return settings.model_name


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
    kind_titles = _kind_titles()
    for index, detection in enumerate(detections, start=1):
        kind = detection.get("kind", "unknown")
        topic = detection.get("topic", "/unknown")
        evidence = detection.get("evidence", {})
        title_template = kind_titles.get(kind, "Anomaly on {topic}" if getattr(get_settings(), "llm_language", "vi") != "vi" else "Bất thường trên {topic}")
        title = title_template.format(
            topic=topic,
            node=evidence.get("node", "unknown"),
        )
        metric_parts = []
        for key in (
            "interval_sec",
            "active_span_sec",
            "max_gap_sec",
            "gap_sec",
            "jitter_sec",
            "drift_sec",
            "expected_hz",
            "actual_hz",
            "drop_pct",
            "max_latency_ms",
            "threshold_ms",
            "threshold_sec",
            "occurrence_count",
            "child_frame",
            "max_nan_ratio",
            "max_out_of_range_ratio",
            "max_jump_m",
            "drift_rate_ms_per_sec",
            "direction",
            "pattern",
        ):
            if key in evidence:
                metric_parts.append(f"{key.replace('_', ' ')} {evidence[key]}")
        summaries.append(
            {
                "id": detection.get("id", f"anomaly_{index:03d}"),
                "runId": run_id,
                "kind": kind,
                "title": title,
                "severity": detection.get("severity", "low"),
                "tSec": float(detection.get("tSec", 0.0)),
                "endSec": float(detection.get("endSec", 0.0)),
                "tRelSec": float(detection.get("tRelSec", 0.0)),
                "endRelSec": float(detection.get("endRelSec", 0.0)),
                "topics": [topic],
                "confidence": float(detection.get("confidence", 0.5)),
                "metric": "; ".join(metric_parts) or f"detected on {topic}",
                "evidence": evidence,
            }
        )
    return summaries


def _canned_explanation(detection: dict[str, Any]) -> dict[str, Any]:
    """Build a deterministic explanation for one detection, used when the LLM is unavailable."""
    kind = detection.get("kind", "unknown")
    topic = detection.get("topic", "/unknown")
    is_vi = getattr(get_settings(), "llm_language", "vi") == "vi"
    if is_vi:
        canned = {
            "frequency_gap": (
                f"Phát hiện khoảng trống phát hành thường xuyên trên {topic}.",
                "Luồng phát của node bị nghẽn hoặc bộ đệm truyền dẫn làm gián đoạn việc xuất bản.",
            ),
            "message_drop_burst": (
                f"Phát hiện cụm mất gói tin trên {topic}.",
                "Một khoảng trống dài giữa hai bản tin cho thấy gói tin bị rơi hoặc bị gộp.",
            ),
            "timestamp_jitter": (
                f"Phát hiện jitter dấu thời gian trên {topic}.",
                "Nhịp phát hành dao động vượt ngưỡng so với tần suất danh định.",
            ),
            "silent_node": (
                f"Phát hiện node im lặng trên topic {topic}.",
                "Node đã ngừng phát hành trong toàn bộ cửa sổ quan sát.",
            ),
            "clock_drift": (
                f"Phát hiện trôi đồng hồ trên {topic}.",
                "Dấu thời gian trong header lệch so với thời gian ghi của bag.",
            ),
            "unknown": (
                f"Phát hiện mẫu bất thường trên {topic}.",
                "Tín hiệu thô lệch khỏi nhịp kỳ vọng.",
            ),
        }
        issue, root_cause = canned.get(kind, canned["unknown"])
        return {
            "root_cause": root_cause,
            "recommended_actions": [
                "Kiểm tra node nguồn xem có tắc nghẽn luồng phát hoặc chết thread không.",
                "Kiểm tra đường truyền/mạng và bộ ghi xem có hiện tượng chập chờn hoặc mất gói theo cụm không.",
            ],
            "explanation": f"{issue} {root_cause}",
        }
    canned = {
        "frequency_gap": (
            f"Frequent publish gap detected on {topic}.",
            "Producer thread starvation or transport buffering paused publishing.",
        ),
        "message_drop_burst": (
            f"Burst of dropped messages detected on {topic}.",
            "A single long inter-message interval indicates dropped or coalesced messages.",
        ),
        "timestamp_jitter": (
            f"Timestamp jitter detected on {topic}.",
            "Publish cadence deviates more than expected from the nominal rate.",
        ),
        "silent_node": (
            f"Node silence detected for topic {topic}.",
            "The node stopped publishing for the full observation window.",
        ),
        "clock_drift": (
            f"Clock drift detected on {topic}.",
            "Message header stamps drift from the bag recording timestamps.",
        ),
        "unknown": (
            f"Anomaly pattern detected on {topic}.",
            "Raw signal deviates from the expected cadence.",
        ),
    }
    issue, root_cause = canned.get(kind, canned["unknown"])
    return {
        "root_cause": root_cause,
        "recommended_actions": [
            "Check the producing node for publish stalls or thread starvation.",
            "Validate the network / recorder path for bursty or dropped message windows.",
        ],
        "explanation": f"{issue} {root_cause}",
    }


def _canned_ai_results(run_id: str, detections: list[dict[str, Any]]) -> list[AIResultSummary]:
    """Build deterministic AI results from real detections when inference is unavailable.

    Canned explanations are routed through :func:`_ai_result_from_explanation` so the
    fallback output shares the exact same shape as the real LLM path.
    """
    return [
        _ai_result_from_explanation(
            run_id, index, detection, _canned_explanation(detection), model="canned-fallback"
        )
        for index, detection in enumerate(detections, start=1)
    ]


_ROLE_LABEL_VI = {"primary": "nguyên phát", "consequence": "hệ quả"}


def _finding_detail(explanation: dict[str, Any], finding: dict[str, str] | None) -> str:
    detail = str(explanation.get("explanation", ""))
    if finding and finding.get("detail"):
        role = str(finding.get("role", ""))
        if getattr(get_settings(), "llm_language", "vi") == "vi":
            role = _ROLE_LABEL_VI.get(role, role)
        detail = f"{role}: {finding['detail']}"
    return detail


def _evidence_item(
    detection: dict[str, Any], explanation: dict[str, Any], finding: dict[str, str] | None
) -> EvidenceItem:
    return EvidenceItem(
        topic=detection.get("topic", "/unknown"),
        tSec=float(detection.get("tSec", 0.0)),
        detail=_finding_detail(explanation, finding),
    )


def _ai_result_from_explanation(
    run_id: str,
    index: int,
    detection: dict[str, Any],
    explanation: dict[str, Any],
    model: str = "llm-explain",
    finding: dict[str, str] | None = None,
    evidence: list[EvidenceItem] | None = None,
    latency_ms: int = 0,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> AIResultSummary:
    return AIResultSummary(
        id=f"ai_{index:03d}",
        runId=run_id,
        anomalyId=f"anomaly_{index:03d}",
        issue=str(explanation.get("root_cause", "")),
        rootCause=str(explanation.get("root_cause", "")),
        confidence=float(detection.get("confidence", 0.5)),
        explanation=str(explanation.get("explanation", "")),
        suggestedFix=[str(a) for a in explanation.get("recommended_actions", [])],
        evidence=evidence if evidence is not None else [_evidence_item(detection, explanation, finding)],
        reviewStatus="pending",
        model=model,
        latencyMs=latency_ms,
        promptTokens=prompt_tokens,
        completionTokens=completion_tokens,
        llmRequestId=f"llm_req_{index:03d}",
    )


def _cluster_detections(detections: list[dict[str, Any]]) -> list[list[int]]:
    """Group detections into incidents by whether their active spans overlap.

    Returns lists of positions into ``detections``, ordered by onset within each
    group so the earliest anomaly is presented first — the model leans on that
    ordering to tell the originating fault from what stalled behind it.

    Clustering on *onset distance* fragmented long incidents: a 40s transform
    gap and the controller stall it causes both run for tens of seconds, but
    their individual detections start more than the old 5s window apart, so the
    originating fault and its cascade landed in different clusters. Measured on
    38 real bags, that left 49.3% of clusters holding only cascade topics —
    payloads where naming the true root cause is impossible, whatever the model.
    Grouping by span overlap instead (a detection joins while it starts before
    the running incident ends, plus ``_CLUSTER_SLACK_SEC`` for propagation
    delay) cut those to 18.2% and singletons from 24.6% to 18.2%.

    Instantaneous detections (``endSec == tSec``) still cluster by the slack
    window exactly as before, so short incidents are unaffected.
    """
    by_onset = sorted(range(len(detections)), key=lambda p: float(detections[p].get("tSec", 0.0)))
    clusters: list[list[int]] = []
    incident_end: float | None = None
    for position in by_onset:
        onset = float(detections[position].get("tSec", 0.0))
        end = float(detections[position].get("endSec", onset))
        if incident_end is None or onset > incident_end + _CLUSTER_SLACK_SEC:
            clusters.append([])
            incident_end = end
        else:
            incident_end = max(incident_end, end)
        clusters[-1].append(position)
    return clusters


def _cascade_fragment_clusters(
    detections: list[dict[str, Any]], clusters: list[list[int]]
) -> set[int]:
    """Identify clusters that hold nothing but downstream stalls.

    A cluster containing only actuator-layer topics carries no diagnostic
    content: the controller stopped, and the reason is not in this payload.
    Asking for its root cause can only ever yield the actuator itself, which is
    wrong by construction — measured on real bags these accounted for 10 of the
    12 clusters that could not possibly be answered correctly.

    The test is deliberately run-wide, not per-cluster: when a recording has no
    upstream anomaly anywhere, the actuator really is the originating fault and
    the cluster must be explained normally.
    """
    has_upstream_anywhere = any(
        _topic_layer(str(detection.get("topic", ""))) < _ACTUATOR_LAYER for detection in detections
    )
    if not has_upstream_anywhere:
        return set()
    return {
        index
        for index, cluster in enumerate(clusters)
        if all(_topic_layer(str(detections[p].get("topic", ""))) == _ACTUATOR_LAYER for p in cluster)
    }


def _cascade_fragment_explanation(detection: dict[str, Any]) -> dict[str, Any]:
    topic = detection.get("topic", "/unknown")
    if getattr(get_settings(), "llm_language", "vi") == "vi":
        return {
            "root_cause": (
                f"{topic} đình trệ do hệ quả của sự cố phía trước; lỗi gốc được báo cáo "
                "ở sự cố khác trong cùng lượt chạy."
            ),
            "explanation": (
                f"Cửa sổ này chỉ chứa hoạt động của {topic}, không có bằng chứng về nguyên nhân "
                "gây đình trệ. Hãy xem xét cùng với sự cố chính của lượt chạy."
            ),
            "recommended_actions": [
                "Xem xét sự đình trệ này cùng với sự cố chính thay vì đánh giá riêng lẻ.",
            ],
        }
    return {
        "root_cause": (
            f"{topic} stalled as a downstream consequence; the originating fault is reported "
            "in another incident of this run."
        ),
        "explanation": (
            f"This window contains only {topic} activity, so it carries no evidence of what "
            "caused the stall. Review it together with the run's primary incident."
        ),
        "recommended_actions": [
            "Review this stall alongside the run's primary incident rather than on its own.",
        ],
    }


def _build_ai_results(
    run_id: str,
    detections: list[dict[str, Any]],
    recording: dict[str, float] | None = None,
) -> list[AIResultSummary]:
    """Produce AI results per detection, explaining co-occurring ones together.

    Detections that start within the same window are sent to the LLM as one
    incident, so it can name the fault that began it and mark the rest as
    consequences; explained alone, every stalled consumer reads as its own
    independent failure and the remediation points at the victim. Falls back to
    deterministic canned results when the LLM is unavailable or a call fails, so
    an analysis run never fails on inference.
    """
    if not is_llm_configured() or not detections:
        return _canned_ai_results(run_id, detections)

    results: dict[int, AIResultSummary] = {}
    clusters = _cluster_detections(detections)
    cascade_only = _cascade_fragment_clusters(detections, clusters)
    is_vi = getattr(get_settings(), "llm_language", "vi") == "vi"
    for cluster_index, cluster in enumerate(clusters):
        if cluster_index in cascade_only:
            for position in cluster:
                results[position] = _ai_result_from_explanation(
                    run_id,
                    position + 1,
                    detections[position],
                    _cascade_fragment_explanation(detections[position]),
                    model="cascade-fragment",
                    finding={"role": "consequence", "detail": "Đình trệ hệ quả từ sự cố được báo cáo riêng." if is_vi else "Downstream stall from the incident reported separately."},
                )
            continue
        try:
            explanation = explain_detection_cluster(
                [detections[p] for p in cluster], recording=recording
            )
        except Exception:
            logger.warning(
                "analysis.ai_fallback",
                extra={
                    "diagnostics": {
                        "event": "analysis.ai_fallback",
                        "level": "warning",
                        "details": {"run_id": run_id, "cluster_size": len(cluster)},
                    }
                },
            )
            for position in cluster:
                results[position] = _ai_result_from_explanation(
                    run_id,
                    position + 1,
                    detections[position],
                    _canned_explanation(detections[position]),
                    model="canned-fallback",
                )
            continue
        findings = explanation.get("findings", {})
        usage = explanation.get("usage") or {}
        # A reviewer opening any one result in a cluster should see the whole
        # incident's evidence chain, not just its own detection — build every
        # finding's EvidenceItem once, then reorder per row so each row's own
        # item stays first (preserves the existing evidence[0] contract).
        cluster_evidence = [
            _evidence_item(detections[position], explanation, findings.get(offset))
            for offset, position in enumerate(cluster, start=1)
        ]
        for offset, position in enumerate(cluster, start=1):
            own = offset - 1
            ordered_evidence = [cluster_evidence[own], *cluster_evidence[:own], *cluster_evidence[own + 1 :]]
            results[position] = _ai_result_from_explanation(
                run_id,
                position + 1,
                detections[position],
                explanation,
                finding=findings.get(offset),
                evidence=ordered_evidence,
                # One chat_completion call explains the whole cluster; attribute
                # its usage to the first result only so summing promptTokens
                # across all AI results of a run doesn't overcount by cluster size.
                latency_ms=int(usage.get("latency_ms", 0)) if offset == 1 else 0,
                prompt_tokens=int(usage.get("prompt_tokens", 0)) if offset == 1 else 0,
                completion_tokens=int(usage.get("completion_tokens", 0)) if offset == 1 else 0,
            )
    return [results[position] for position in sorted(results)]


_SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def select_run_root_cause(
    detections: list[dict[str, Any]], ai_results: list[AIResultSummary]
) -> dict[str, Any] | None:
    """Pick the one conclusion that represents the whole run.

    Each incident gets its own root cause, so a recording with several incidents
    produced several competing conclusions and nothing decided which one the
    operator should read first — measured on 38 bags, 94.7% had at least one
    correct conclusion, but no step surfaced it. Rank by worst severity, then by
    earliest onset (severity alone left ties, and the earliest incident is the
    one that plausibly caused the later ones).

    Returns None when there is nothing to conclude.
    """
    by_root_cause: dict[str, dict[str, Any]] = {}
    for result in ai_results:
        detection = next(
            (d for d in detections if d.get("id") == result.anomalyId),
            None,
        )
        if detection is None or not result.rootCause:
            continue
        entry = by_root_cause.setdefault(
            result.rootCause,
            {
                "rootCause": result.rootCause,
                "explanation": result.explanation,
                "suggestedFix": result.suggestedFix,
                "severity": "low",
                "tSec": float("inf"),
                "anomalyIds": [],
            },
        )
        severity = str(detection.get("severity", "low"))
        if _SEVERITY_ORDER.get(severity, 0) > _SEVERITY_ORDER.get(entry["severity"], 0):
            entry["severity"] = severity
        entry["tSec"] = min(entry["tSec"], float(detection.get("tSec", 0.0)))
        entry["anomalyIds"].append(result.anomalyId)

    if not by_root_cause:
        return None
    return max(
        by_root_cause.values(),
        key=lambda entry: (_SEVERITY_ORDER.get(entry["severity"], 0), -entry["tSec"]),
    )


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


def _finalize_run_llm_usage(
    run: AnalysisRun, ai_results: list[AIResultSummary], started: float
) -> AnalysisRun:
    """Roll per-result token/latency usage up into the run and price it.

    Runs the LLM explain step, so must run after `_build_ai_results` — the
    dashboard's "mean diagnosis time" is meant to cover parse through AI
    conclusion, which this also corrects (the prior timestamp was taken
    before that step ran, so it never included it).
    """
    prompt_tokens = sum(result.promptTokens for result in ai_results)
    completion_tokens = sum(result.completionTokens for result in ai_results)
    resolved_model = _configured_model()
    return run.model_copy(
        update={
            "totalLatencyMs": int((time.perf_counter() - started) * 1000),
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "costUsd": _compute_cost_usd(resolved_model, prompt_tokens, completion_tokens),
        }
    )


def run_analysis(dataset_id: str, model: str | None = None, owner: str = "admin") -> dict[str, Any]:
    """Run the full analysis pipeline for a dataset and persist its results.

    Locates the dataset bag files, streams them through the rule-based
    diagnostics, builds AI explanations, then persists the run, detections,
    AI results and review items via :mod:`src.services.run_store`.

    Args:
        dataset_id: ID of the dataset (folder name under ``data/<owner>/``) to analyze.
        model: Optional model label recorded on the run.
        owner: Owner username (from JWT sub).

    Returns:
        Dict with ``run`` (``AnalysisRun``), ``detections`` (raw detection
        dicts), ``ai_results`` (``AIResultSummary`` list) and ``health``
        (the Health Summary JSON).

    Raises:
        ValueError: No dataset with the given id exists for this owner.
    """
    ds = next((d for d in list_experiments(owner) if d["id"] == dataset_id), None)
    if ds is None:
        raise ValueError(f"dataset not found: {dataset_id}")

    started_at = datetime.now(UTC).isoformat()
    started = time.perf_counter()
    resolved_model = model or _configured_model()

    bag_files = experiment_bag_files(dataset_id, owner)
    if not bag_files:
        run = _pending_run_from_dataset(ds, resolved_model)
        detections: list[dict[str, Any]] = []
        total_messages = 0
        recording = None
    else:
        try:
            with perf.timed_phase("analysis.detect", {"id": ds["id"], "bags": [b.name for b in bag_files]}):
                stream = chain.from_iterable(iter_bag_messages(bag_path) for bag_path in bag_files)
                analysis_result = detect_anomalies(stream, None)
            detections = analysis_result.get("detections", [])
            summary = analysis_result.get("summary", {})
            total_messages = int(summary.get("total_messages", 0))
            recording = {
                "start_sec": float(summary.get("stream_start_sec", 0.0)),
                "end_sec": float(summary.get("stream_end_sec", 0.0)),
            }
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
            recording = None

    with perf.timed_phase("analysis.ai", {"id": run.id, "detections": len(detections)}):
        ai_results = _build_ai_results(run.id, detections, recording)
        run = _finalize_run_llm_usage(run, ai_results, started)
    with perf.timed_phase("analysis.persist", {"id": run.id}):
        report_health = compute_health_summary(detections, total_messages=total_messages)
        run_store.save_run(run.model_dump(), owner)
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
        "run_root_cause": select_run_root_cause(detections, ai_results),
    }
