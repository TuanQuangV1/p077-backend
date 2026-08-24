"""RAV-13 Diagnostics API routes.

All state is persisted in SQLite via :mod:`src.services.run_store` (runs,
detections, AI results, review queue) instead of module-level dicts, so data
survives restarts and tests stay isolated. Optional API-token auth and
in-memory rate limiting protect the public endpoints.
"""

import functools
import hmac
import logging
import os
import json
from collections import Counter, defaultdict
from collections.abc import Iterator
from itertools import chain
from pathlib import Path
from typing import Any

import anyio
import httpx
from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse

from src.config import get_settings
from src.models.schemas import (
    AIResultSummary,
    AnalysisCreateRequest,
    AnalysisCreateResponse,
    AnalysisDetailResponse,
    AnalysisRun,
    ChatRequest,
    ChatResponse,
    DashboardOverviewResponse,
    DashboardReviewDecisionRequest,
    DashboardReviewDecisionResponse,
    DatasetItem,
    DatasetListResponse,
    DiagnosticsExplanationRequest,
    DiagnosticsExplanationResponse,
    DiagnosticsRequest,
    DiagnosticsSummaryResponse,
    DiagnosticsThresholdsResponse,
    DiagnosticsThresholdsUpdateRequest,
    HealthSummaryResponse,
    HiltFixRequest,
    HiltFixResponse,
    HiltSummary,
    ReviewItem,
    ReviewListResponse,
    ReviewStatsResponse,
    ReviewStatsRun,
    RunRootCause,
)
from src.services import run_store
from src.services.analysis import (
    _KIND_LABELS,
    _anomaly_summaries,
    _build_ai_results,
    run_analysis,
    select_run_root_cause,
)
from src.services.bag_stream import iter_bag_messages
from src.services.diagnostics import detect_anomalies, parse_mcap_file
from src.services.diagnostics_config import get_diagnostics_thresholds, save_diagnostics_thresholds
from src.services.health import DEEP_DIVE_TRIGGER_THRESHOLD, build_deep_dive_prompt, compute_health_summary
from src.services.iterative_debug import IterativeDebugger
from src.services.rate_limit import SlidingWindowRateLimiter
from src.services.window_export import iter_window_jsonl_lines
from src.services.experiments import (
    MAX_UPLOAD_BYTES,
    delete_experiment,
    experiment_bag_files,
    list_experiments,
    save_uploaded_rosbag,
)
from src.services.llm import (
    CHAT_SYSTEM_PROMPT,
    chat_completion,
    explain_diagnostics,
    is_llm_configured,
)

logger = logging.getLogger(__name__)

_RATE_LIMIT_MAX_REQUESTS = int(os.environ.get("RATE_LIMIT_MAX_REQUESTS", "120"))
_RATE_LIMIT_WINDOW_SEC = float(os.environ.get("RATE_LIMIT_WINDOW_SEC", "60"))

_rate_limiter = SlidingWindowRateLimiter(_RATE_LIMIT_MAX_REQUESTS, _RATE_LIMIT_WINDOW_SEC)


def _require_auth(authorization: str | None = Header(default=None)) -> None:
    """Reject requests unless they carry the configured API token.

    No-op when ``API_AUTH_TOKEN`` is unset (development default), which keeps
    the frontend and local tooling working without extra headers.
    """
    token = get_settings().api_auth_token
    if not token:
        return
    if authorization is None or not hmac.compare_digest(authorization, f"Bearer {token}"):
        raise HTTPException(status_code=401, detail="invalid or missing API token")


def _check_rate_limit(request: Request) -> None:
    """Sliding-window in-memory rate limit keyed by client IP.

    When the direct client address is unavailable (e.g. behind a proxy that
    strips headers), each forwarded IP from ``X-Forwarded-For`` is used so that
    anonymous traffic does not share a single "unknown" bucket that could be
    exhausted by a single abusive client.
    """
    client_host = request.client.host if request.client else None
    forwarded_for = request.headers.get("x-forwarded-for")
    key = forwarded_for.split(",")[0].strip() or client_host or "unknown" if forwarded_for else client_host or "unknown"
    if not _rate_limiter.allow(key):
        raise HTTPException(status_code=429, detail="rate limit exceeded")


router = APIRouter(dependencies=[Depends(_require_auth)])


def _resolve_diagnostics_file_path(file_path: str) -> Path:
    """Resolve and validate a diagnostics file path inside ``data/diagnostics``.

    Only relative paths inside ``data/diagnostics`` are accepted to prevent
    path traversal. Returns the resolved ``Path`` or raises an HTTPException.

    Args:
        file_path: Relative path to the diagnostics file (e.g. ``bag_01/mcap.jsonl``).

    Returns:
        Resolved ``Path`` verified to live inside the data directory.

    Raises:
        HTTPException 400: The path is invalid or escapes the allowed directory.
        HTTPException 404: The file does not exist.
    """
    requested_path = Path(file_path)
    if requested_path.is_absolute() or ".." in requested_path.parts:
        raise HTTPException(status_code=400, detail="invalid diagnostics file path")

    base_dir = (Path.cwd() / "data" / "diagnostics").resolve()
    resolved = (base_dir / requested_path).resolve()
    if resolved != base_dir and base_dir not in resolved.parents:
        raise HTTPException(status_code=400, detail="invalid diagnostics file path")

    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail="diagnostics file not found")

    return resolved


def _load_datasets() -> list[DatasetItem]:
    """Scan data/ subfolders for rosbag datasets (cached by :func:`list_experiments`)."""
    return [
        DatasetItem(
            id=exp["id"],
            name=exp["name"],
            robotType=exp["robotType"],
            sizeBytes=exp["sizeBytes"],
            durationSec=exp["durationSec"],
            recordedAt=exp["recordedAt"],
            uploadedAt=exp["uploadedAt"],
            status=exp["status"],
            messageCount=exp["messageCount"],
            topics=exp["topics"],
            site=exp["site"],
            rosVersion=exp["rosVersion"],
        )
        for exp in list_experiments()
    ]


def _p95(values: list[int]) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))
    return int(ordered[idx])


@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    _rate_limited: None = Depends(_check_rate_limit),
) -> ChatResponse:
    """Chat with the LLM through an OpenAI-compatible endpoint (httpx, manual tool-calling).

    Sends the message directly to vLLM/OpenAI. When the LLM is not configured,
    returns a guidance response instead of an error.

    Args:
        request: User message content.

    Returns:
        ``ChatResponse`` containing the answer.

    Raises:
        HTTPException 500: The LLM upstream failed while processing the request.
    """
    if not is_llm_configured():
        return ChatResponse(
            response=(
                "LLM chưa được cấu hình. Cấu hình llm_provider='vllm' kèm "
                "vllm_base_url/vllm_api_key hoặc llm_provider='openai' kèm "
                "openai_api_key để bật chat thật."
            ),
            analysis="",
        )
    try:
        result = await anyio.to_thread.run_sync(
            chat_completion,
            [
                {"role": "system", "content": CHAT_SYSTEM_PROMPT},
                {"role": "user", "content": request.message},
            ],
        )
        return ChatResponse(response=result["message"].get("content", ""), analysis="")
    except Exception as e:
        logger.warning(
            "chat.upstream_failed",
            extra={
                "diagnostics": {
                    "event": "chat.upstream_failed",
                    "level": "warning",
                    "details": {"error_type": type(e).__name__},
                }
            },
        )
        raise HTTPException(status_code=500, detail="LLM request failed; please try again later") from e


@router.get("/status")
async def agent_status() -> dict[str, str]:
    """Check the API health status.

    Returns:
        Dict with the status and version name.
    """
    return {"status": "ready", "agent": "RAV-13 Diagnostics API v1.0"}


@router.get("/datasets", response_model=DatasetListResponse)
async def datasets(
    limit: int | None = Query(default=None, ge=1),
    offset: int | None = Query(default=None, ge=0),
) -> DatasetListResponse:
    """List uploaded rosbag datasets, scanned from data/.

    Args:
        limit: Maximum number of items to return (pagination).
        offset: Starting position for pagination.

    Returns:
        ``DatasetListResponse`` with the dataset list and the total count.
    """
    items = await anyio.to_thread.run_sync(_load_datasets)
    total = len(items)
    if offset is not None:
        items = items[offset:]
    if limit is not None:
        items = items[:limit]
    return DatasetListResponse(items=items, total=total)


@router.post("/datasets/upload", response_model=DatasetItem, status_code=status.HTTP_201_CREATED)
async def upload_dataset(
    request: Request,
    file: UploadFile = File(...),
    _rate_limited: None = Depends(_check_rate_limit),
) -> DatasetItem:
    """Upload a new rosbag (.db3/.mcap/.bag) or rosbag2 zip file.

    Stores the file under ``data/<id>/`` and generates minimal ``metadata.yaml``
    if missing, then returns the matching ``DatasetItem``.

    Args:
        request: Original request (used to check ``Content-Length``).
        file: Uploaded multipart file.

    Returns:
        ``DatasetItem`` describing the just-stored rosbag.

    Raises:
        HTTPException 400: Unsupported format or unsafe zip content.
        HTTPException 413: Upload exceeds the size limit.
    """
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="upload exceeds size limit")
    try:
        item = await anyio.to_thread.run_sync(save_uploaded_rosbag, file.filename or "", file.file)
    except ValueError as e:
        if "size limit" in str(e):
            raise HTTPException(status_code=413, detail=str(e)) from e
        raise HTTPException(status_code=400, detail=str(e)) from e
    logger.info(
        "datasets.uploaded",
        extra={
            "diagnostics": {
                "event": "datasets.uploaded",
                "level": "info",
                "details": {"id": item["id"], "sizeBytes": item["sizeBytes"]},
            }
        },
    )
    return DatasetItem(**item)


@router.delete("/datasets/{dataset_id}", response_model=dict)
async def delete_dataset(dataset_id: str) -> dict[str, str | bool]:
    """Delete a dataset (folder) under data/.

    Args:
        dataset_id: ID of the dataset to delete (folder name).

    Returns:
        Dict confirming the deletion result.

    Raises:
        HTTPException 404: No dataset found with the given ID.
    """
    deleted = await anyio.to_thread.run_sync(delete_experiment, dataset_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="dataset not found")
    logger.info(
        "datasets.deleted",
        extra={
            "diagnostics": {
                "event": "datasets.deleted",
                "level": "info",
                "details": {"id": dataset_id},
            }
        },
    )
    return {"ok": True, "id": dataset_id}


@router.get("/dashboard/overview", response_model=DashboardOverviewResponse)
async def dashboard_overview() -> DashboardOverviewResponse:
    """Return dashboard overview metrics computed from real data.

    Every metric (rosbag count, runs, anomalies, severity, pending reviews,
    trend) is derived from datasets and persisted runs; no fake data remains.

    Returns:
        ``DashboardOverviewResponse`` containing all overview data.
    """
    datasets = await anyio.to_thread.run_sync(_load_datasets)
    runs = await anyio.to_thread.run_sync(run_store.list_runs)
    anomalies_by_run = await anyio.to_thread.run_sync(
        run_store.get_runs_anomalies, [run["id"] for run in runs]
    )
    all_anomalies: list[dict[str, Any]] = [
        anomaly for run in runs for anomaly in anomalies_by_run.get(run["id"], [])
    ]
    review_items = await anyio.to_thread.run_sync(run_store.list_review_items)

    succeeded = [r for r in runs if r["status"] == "succeeded"]
    runs_with_issues = [r for r in succeeded if r["anomalyCount"] > 0]
    total_messages = sum(ds.messageCount for ds in datasets)
    total_hours = sum(ds.durationSec for ds in datasets) / 3600.0
    latency_ms = [r["totalLatencyMs"] for r in succeeded]

    kind_counts = Counter(str(a.get("kind", "unknown")) for a in all_anomalies)
    severity_counts = Counter(str(a.get("severity", "low")) for a in all_anomalies)
    open_critical = sum(1 for a in all_anomalies if a.get("severity") == "critical")

    trend_by_date: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"bags": set(), "anomalies": 0, "latencies": [], "cost": 0.0}
    )
    for run in runs:
        date = run["startedAt"][:10]
        entry = trend_by_date[date]
        entry["bags"].add(run["rosbagId"])
        entry["anomalies"] += run["anomalyCount"]
        entry["latencies"].append(run["totalLatencyMs"])
        entry["cost"] += run["costUsd"]

    return DashboardOverviewResponse(
        totals={
            "rosbags": len(datasets),
            "analyzed": len(succeeded),
            "messages": total_messages,
            "hoursOfData": round(total_hours, 2),
            "runsWithIssuesPct": (round(len(runs_with_issues) / len(succeeded) * 100, 1) if succeeded else 0.0),
            "anomalies": len(all_anomalies),
            "criticalOpen": open_critical,
            "meanTimeToDiagnoseSec": (int(sum(latency_ms) / len(latency_ms) / 1000) if latency_ms else 0),
            "inferenceCostUsd": round(sum(r["costUsd"] for r in runs), 4),
            "tokens": sum(r["promptTokens"] + r["completionTokens"] for r in runs),
            "reviewPending": sum(1 for r in review_items if r["reviewStatus"] == "pending"),
        },
        topIssues=[
            {
                "kind": kind,
                "label": _KIND_LABELS.get(kind, kind.replace("_", " ").title()),
                "count": count,
            }
            for kind, count in kind_counts.most_common(5)
        ],
        severity=[
            {"severity": level, "count": severity_counts.get(level, 0)}
            for level in ("critical", "high", "medium", "low")
        ],
        trend=[
            {
                "date": date,
                "bags": len(entry["bags"]),
                "anomalies": entry["anomalies"],
                "p95Ms": _p95(entry["latencies"]),
                "costUsd": round(entry["cost"], 4),
            }
            for date, entry in sorted(trend_by_date.items())
        ],
        recentRuns=[AnalysisRun(**run) for run in runs[:5]],
    )


@router.post("/analysis", response_model=AnalysisCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_analysis(
    request: AnalysisCreateRequest,
    _rate_limited: None = Depends(_check_rate_limit),
) -> AnalysisCreateResponse:
    """Run real diagnostics on a dataset's rosbag.

    Reads the bag file (``parse_rosbag2_db3`` for .db3), runs
    ``detect_anomalies``, generates AI results and persists run/anomalies/
    review items in SQLite.

    Args:
        request: Analysis request (rosbag id, optional model).

    Returns:
        ``AnalysisCreateResponse`` with the created run and the WebSocket channel.

    Raises:
        HTTPException 404: No dataset found with the given ID.
    """
    datasets = await anyio.to_thread.run_sync(_load_datasets)
    match = next((ds for ds in datasets if ds.id == request.rosbag_id), None)
    if not match:
        raise HTTPException(status_code=404, detail="dataset not found")

    result = await anyio.to_thread.run_sync(run_analysis, request.rosbag_id, request.model)
    run = result["run"]
    return AnalysisCreateResponse(
        run=run,
        channel=f"/ws/runs/{run.id}",
    )


@router.get("/analysis/thresholds", response_model=DiagnosticsThresholdsResponse)
async def get_thresholds() -> DiagnosticsThresholdsResponse:
    """Get the current diagnostics thresholds.

    Returns:
        ``DiagnosticsThresholdsResponse`` with all thresholds in effect.
    """
    thresholds = await anyio.to_thread.run_sync(get_diagnostics_thresholds)
    logger.debug(
        "diagnostics.thresholds.read",
        extra={
            "diagnostics": {
                "event": "diagnostics.thresholds.read",
                "level": "debug",
                "details": {"thresholds": thresholds},
            }
        },
    )
    return DiagnosticsThresholdsResponse(thresholds=thresholds)


@router.post("/analysis/thresholds", response_model=DiagnosticsThresholdsResponse)
async def update_thresholds(
    payload: DiagnosticsThresholdsUpdateRequest,
) -> DiagnosticsThresholdsResponse:
    """Update diagnostics thresholds and persist them to configuration.

    Args:
        payload: New thresholds to apply (merged with the current configuration).

    Returns:
        ``DiagnosticsThresholdsResponse`` with the thresholds after saving.
    """
    thresholds = await anyio.to_thread.run_sync(save_diagnostics_thresholds, payload.thresholds)
    logger.info(
        "diagnostics.thresholds.updated",
        extra={
            "diagnostics": {
                "event": "diagnostics.thresholds.updated",
                "level": "info",
                "details": {"thresholds": thresholds},
            }
        },
    )
    return DiagnosticsThresholdsResponse(thresholds=thresholds)


@router.get("/analysis/{run_id}", response_model=AnalysisDetailResponse)
async def get_analysis(run_id: str) -> AnalysisDetailResponse:
    """Get the detailed results of a single analysis run.

    Args:
        run_id: ID of the analysis run to fetch.

    Returns:
        ``AnalysisDetailResponse`` with the run, its rosbag, the real anomaly
        list and the AI results persisted when the run was created.

    Raises:
        HTTPException 404: No run found with the given ID.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")
    run = AnalysisRun(**run_row)
    datasets = await anyio.to_thread.run_sync(_load_datasets)
    rosbag = next((ds for ds in datasets if ds.id == run.rosbagId), None)
    detections = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    persisted_ai = await anyio.to_thread.run_sync(run_store.get_run_ai_results, run_id)
    if persisted_ai:
        ai_results = [AIResultSummary(**result) for result in persisted_ai]
    else:
        # Recording bounds are not persisted with the run, so this rebuild path
        # sends absolute timestamps where the original analysis sent relative
        # ones. It only fires for runs whose AI results are missing.
        ai_results = _build_ai_results(run_id, detections)
    health = compute_health_summary(detections, total_messages=rosbag.messageCount if rosbag else 0)
    root_cause = select_run_root_cause(detections, ai_results)
    return AnalysisDetailResponse(
        run=run,
        rosbag=rosbag,
        anomalies=_anomaly_summaries(run_id, detections),
        aiResults=ai_results,
        health=health,
        runRootCause=RunRootCause(**root_cause) if root_cause else None,
    )


@router.get("/analysis/{run_id}/health", response_model=HealthSummaryResponse)
async def get_analysis_health(run_id: str) -> HealthSummaryResponse:
    """Return the Health Summary JSON for a run's persisted detections.

    The response is the LLM-friendly context payload: a composite 0-100
    ``health_score``, its green/yellow/red zone, the per-group subscores (log,
    frequency, latency, tf, payload) and detections grouped by indicator. A
    ``trigger_llm_deep_dive`` flag fires when the score drops below the
    ``DEEP_DIVE_TRIGGER_THRESHOLD`` (70), signaling the frontend/agent to run a
    root-cause deep-dive.

    Args:
        run_id: ID of the analysis run to summarize.

    Returns:
        ``HealthSummaryResponse`` wrapping the Health Summary JSON.

    Raises:
        HTTPException 404: No run found with the given ID.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")
    datasets = await anyio.to_thread.run_sync(_load_datasets)
    rosbag = next((ds for ds in datasets if ds.id == run_row["rosbagId"]), None)
    detections = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    total_messages = rosbag.messageCount if rosbag else 0
    health = compute_health_summary(detections, total_messages=total_messages)
    return HealthSummaryResponse(health=health)


@router.get("/analysis/{run_id}/deep-dive")
async def analysis_deep_dive(
    run_id: str,
    deep_dive_threshold: float = Query(default=DEEP_DIVE_TRIGGER_THRESHOLD, ge=0.0, le=100.0),
) -> dict[str, object]:
    """Build the LLM deep-dive context for a run.

    Returns the Health Summary plus a ready-to-send context prompt. Callers
    should send the ``prompt`` to ``POST /analysis/explain`` (or the LLM chat
    endpoint) whenever ``trigger_llm_deep_dive`` is true or the user clicked a
    red anomaly band on the dashboard timeline.

    Args:
        run_id: ID of the analysis run.
        deep_dive_threshold: Optional override of the deep-dive trigger score.

    Returns:
        Dict with ``run_id``, ``triggered``, ``threshold``, ``health`` and
        ``prompt``.

    Raises:
        HTTPException 404: No run found with the given ID.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")
    datasets = await anyio.to_thread.run_sync(_load_datasets)
    rosbag = next((ds for ds in datasets if ds.id == run_row["rosbagId"]), None)
    detections = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    total_messages = rosbag.messageCount if rosbag else 0
    health = compute_health_summary(detections, total_messages=total_messages)
    score = float(health.get("health_score", 0.0))
    return {
        "run_id": run_id,
        "triggered": score < deep_dive_threshold,
        "threshold": deep_dive_threshold,
        "health": health,
        "prompt": build_deep_dive_prompt(health),
    }


@router.get("/analysis/{run_id}/export/windows")
async def export_analysis_windows(
    run_id: str,
    window_sec: float = Query(default=10.0, ge=0.01),
) -> StreamingResponse:
    """Stream per-time-window JSONL summaries of a run's bag dataset.

    The dataset bags are re-read in streaming mode (never materialized in
    memory) and summarized into one compact JSONL row per ``(topic, window)``:
    message count, expected/actual publish rate, max gap, interval jitter and
    clock drift. This is the LLM-friendly, low-volume export of the
    denormalized stream.

    Args:
        run_id: ID of the analysis run whose dataset should be exported.
        window_sec: Aggregation window width in seconds.

    Returns:
        An NDJSON stream (``application/x-ndjson``).

    Raises:
        HTTPException 404: The run, its dataset or its bag files are not found.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")
    datasets = await anyio.to_thread.run_sync(_load_datasets)
    dataset = next((ds for ds in datasets if ds.id == run_row["rosbagId"]), None)
    if dataset is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    bag_files = await anyio.to_thread.run_sync(experiment_bag_files, dataset.id)
    if not bag_files:
        raise HTTPException(status_code=404, detail="bag files not found")

    def generate() -> Iterator[str]:
        stream = chain.from_iterable(iter_bag_messages(bag) for bag in bag_files)
        for line in iter_window_jsonl_lines(stream, window_sec=window_sec):
            yield line + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.get("/review", response_model=ReviewListResponse)
async def review_queue(
    status_filter: str = Query(default="pending", alias="status"),
) -> ReviewListResponse:
    """Get AI results in the human review queue.

    Args:
        status_filter: ``pending`` (default), a specific verdict
            (``approved``/``rejected``/``edited``), or ``all`` for every item.

    Returns:
        ``ReviewListResponse`` with the matching review items and total count.
    """
    rows = await anyio.to_thread.run_sync(
        run_store.list_review_items, None if status_filter == "all" else status_filter
    )
    items = [ReviewItem(**item) for item in rows]
    return ReviewListResponse(items=items, total=len(items))


@router.get("/review/stats", response_model=ReviewStatsResponse)
async def review_statistics() -> ReviewStatsResponse:
    """Aggregate human verdicts into agent-accuracy metrics.

    ``accuracy`` is approved / reviewed, per run and overall; it is ``None``
    until at least one item has been reviewed. Recall is not reported because
    it would require ground truth for anomalies the agent never raised.

    Returns:
        ``ReviewStatsResponse`` with overall totals and a per-run breakdown.
    """

    def _accuracy(approved: int, reviewed: int) -> float | None:
        return round(approved / reviewed, 4) if reviewed else None

    per_run = await anyio.to_thread.run_sync(run_store.review_stats)
    runs = []
    for row in per_run:
        reviewed = row["approved"] + row["rejected"] + row["edited"]
        runs.append(
            ReviewStatsRun(
                runId=row["runId"],
                rosbagName=row["rosbagName"],
                total=row["total"],
                reviewed=reviewed,
                approved=row["approved"],
                rejected=row["rejected"],
                edited=row["edited"],
                pending=row["pending"],
                accuracy=_accuracy(row["approved"], reviewed),
            )
        )

    approved = sum(run.approved for run in runs)
    rejected = sum(run.rejected for run in runs)
    edited = sum(run.edited for run in runs)
    reviewed = approved + rejected + edited
    return ReviewStatsResponse(
        total=sum(run.total for run in runs),
        reviewed=reviewed,
        approved=approved,
        rejected=rejected,
        edited=edited,
        pending=sum(run.pending for run in runs),
        accuracy=_accuracy(approved, reviewed),
        runs=runs,
    )


@router.post("/analysis/diagnose", response_model=DiagnosticsSummaryResponse)
async def diagnose(request: DiagnosticsRequest) -> DiagnosticsSummaryResponse:
    """Run diagnostics on a ROS message stream.

    Accepts inline data or a ``.mcap`` (JSONL) file path, detects anomalies
    (frequency gaps, silent nodes) against the configured thresholds and logs
    detailed information for each request.

    Args:
        request: Message list and/or ``file_path`` plus optional thresholds.

    Returns:
        ``DiagnosticsSummaryResponse`` with the summary, detections, thresholds
        and analysis logs.

    Raises:
        HTTPException 400/404: ``file_path`` is invalid or does not exist.
    """
    messages = request.messages
    if request.file_path:
        file_path = _resolve_diagnostics_file_path(request.file_path)
        messages = await anyio.to_thread.run_sync(parse_mcap_file, file_path)

    result = await anyio.to_thread.run_sync(detect_anomalies, messages, request.thresholds)
    log_payload = {
        "event": "diagnostics.request",
        "level": "info",
        "message": "Diagnostics request received.",
        "details": {
            "source": "file" if request.file_path else "inline",
            "message_count": len(messages),
            "topic_count": len({msg.get("topic") for msg in messages if "topic" in msg}),
            "node_count": len({msg.get("node") for msg in messages if "node" in msg}),
            "thresholds": result.get("thresholds"),
            "total_detections": result.get("summary", {}).get("total_detections"),
        },
    }
    logger.info("diagnostics.request", extra={"diagnostics": log_payload})
    return DiagnosticsSummaryResponse(**result)


@router.post("/analysis/explain", response_model=DiagnosticsExplanationResponse)
async def explain(
    request: DiagnosticsExplanationRequest,
    _rate_limited: None = Depends(_check_rate_limit),
) -> DiagnosticsExplanationResponse:
    """Explain diagnostics results with the LLM.

    Sends the analysis summary to the LLM to generate a root cause and
    suggested remediation actions.

    Args:
        request: Diagnostics summary to explain.

    Returns:
        ``DiagnosticsExplanationResponse`` with root cause, explanation and
        recommended actions.
    """
    try:
        explanation = await anyio.to_thread.run_sync(explain_diagnostics, request.summary)
    except httpx.HTTPError as exc:
        logger.warning(
            "diagnostics.explain_upstream_failed",
            extra={
                "diagnostics": {
                    "event": "diagnostics.explain_upstream_failed",
                    "level": "warning",
                    "details": {"error_type": type(exc).__name__},
                }
            },
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM provider request failed; verify provider credentials and availability",
        ) from exc
    return DiagnosticsExplanationResponse(**explanation)


@router.get("/hilt/summary/{run_id}", response_model=HiltSummary)
async def get_hilt_summary(
    run_id: str,
    anomaly_id: str = Query(..., description="Anomaly ID to get HILT summary for"),
) -> HiltSummary:
    """Get HILT escalation summary for expert review.

    Returns the complete iteration history, trigger reasons, and diagnostic
    context for a specific anomaly within a run.

    Args:
        run_id: Analysis run ID.
        anomaly_id: Anomaly ID within the run.

    Returns:
        HiltSummary with all iterations and trigger information.

    Raises:
        HTTPException 404: Run or anomaly not found.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")

    anomalies = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    anomaly = next((a for a in anomalies if a.get("id") == anomaly_id), None)
    if anomaly is None:
        raise HTTPException(status_code=404, detail="anomaly not found")

    debugger = IterativeDebugger(run_id, anomaly_id, anomaly)
    triggers = await anyio.to_thread.run_sync(debugger.evaluate_triggers, {})
    hilt_payload = await anyio.to_thread.run_sync(debugger.build_hilt_payload, triggers)

    return HiltSummary(**hilt_payload)


@router.post("/hilt/iterate", response_model=AIResultSummary)
async def hilt_iterate(
    run_id: str = Query(..., description="Analysis run ID"),
    anomaly_id: str = Query(..., description="Anomaly ID"),
    test_pass: bool = Query(..., description="Whether engineer test passed"),
    test_comment: str = Query(default="", description="Engineer test comment"),
    _rate_limited: None = Depends(_check_rate_limit),
) -> AIResultSummary:
    """Run one iteration of the iterative debug loop.

    Records the engineer's test result, evaluates triggers, and returns the
    next LLM suggestion (or escalation payload if triggers fire).

    Args:
        run_id: Analysis run ID.
        anomaly_id: Anomaly ID within the run.
        test_pass: Whether the engineer's test passed.
        test_comment: Optional comment from the engineer.

    Returns:
        Next AIResultSummary from LLM (or canned fallback).

    Raises:
        HTTPException 404: Run or anomaly not found.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")

    anomalies = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    anomaly = next((a for a in anomalies if a.get("id") == anomaly_id), None)
    if anomaly is None:
        raise HTTPException(status_code=404, detail="anomaly not found")

    debugger = IterativeDebugger(run_id, anomaly_id, anomaly)

    feedback_history = await anyio.to_thread.run_sync(run_store.list_hilt_iterations, run_id, anomaly_id)
    feedback_list = [
        {
            "iteration": fb["iteration"],
            "test_pass": fb["test_pass"],
            "comment": fb["test_comment"],
        }
        for fb in feedback_history
    ]

    ai_result = await anyio.to_thread.run_sync(debugger.suggest, feedback_list)

    llm_output = {
        "root_cause": ai_result.rootCause,
        "explanation": ai_result.explanation,
        "confidence": ai_result.confidence,
    }

    iteration_num = len(feedback_history) + 1
    await anyio.to_thread.run_sync(
        functools.partial(
            debugger.record_test,
            iteration=iteration_num,
            llm_root_cause=ai_result.rootCause,
            llm_actions=ai_result.suggestedFix,
            llm_explanation=ai_result.explanation,
            llm_confidence=ai_result.confidence,
            test_pass=test_pass,
            test_comment=test_comment or None,
        )
    )

    triggers = await anyio.to_thread.run_sync(debugger.evaluate_triggers, llm_output)

    if not debugger.should_continue(iteration_num, triggers):
        hilt_payload = await anyio.to_thread.run_sync(debugger.build_hilt_payload, triggers)
        await anyio.to_thread.run_sync(
            run_store.save_expert_fix,
            run_id,
            anomaly_id,
            "ESCALATED: " + ", ".join(triggers),
            [],
            json.dumps(hilt_payload),
        )
        return ai_result

    return ai_result


@router.post("/hilt/fix/{run_id}", response_model=HiltFixResponse)
async def hilt_fix(
    run_id: str,
    anomaly_id: str = Query(..., description="Anomaly ID"),
    payload: HiltFixRequest = Body(...),
) -> HiltFixResponse:
    """Record expert fix for an escalated anomaly.

    The expert provides a corrected root cause and actions, which are stored
    and can be used to update the run's AI result.

    Args:
        run_id: Analysis run ID.
        anomaly_id: Anomaly ID within the run.
        payload: Expert's corrected root cause, actions, and notes.

    Returns:
        HiltFixResponse confirming the fix was recorded.

    Raises:
        HTTPException 404: Run or anomaly not found.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")

    anomalies = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    anomaly = next((a for a in anomalies if a.get("id") == anomaly_id), None)
    if anomaly is None:
        raise HTTPException(status_code=404, detail="anomaly not found")

    await anyio.to_thread.run_sync(
        run_store.save_expert_fix,
        run_id,
        anomaly_id,
        payload.corrected_root_cause,
        payload.corrected_actions,
        payload.notes,
    )

    return HiltFixResponse(ok=True, message="Expert fix recorded successfully")


@router.post("/review/{review_id}/decision", response_model=DashboardReviewDecisionResponse)
async def review_decision(
    review_id: str,
    payload: DashboardReviewDecisionRequest,
) -> DashboardReviewDecisionResponse:
    """Record a review decision (approve/reject) for an AI result.

    Args:
        review_id: ID of the review item to process.
        payload: Verdict, reviewer and notes from the reviewer.

    Returns:
        ``DashboardReviewDecisionResponse`` confirming the recorded decision.

    Raises:
        HTTPException 404: No review item found with the given ID.
    """
    if await anyio.to_thread.run_sync(run_store.get_review_item, review_id) is None:
        raise HTTPException(status_code=404, detail="review item not found")
    await anyio.to_thread.run_sync(
        run_store.update_review_item,
        review_id,
        payload.verdict,
        payload.reviewer or "reviewer",
        payload.notes,
    )
    return DashboardReviewDecisionResponse(
        ok=True,
        verdict=payload.verdict,
        reviewer=payload.reviewer or "reviewer",
        notes=payload.notes,
    )
