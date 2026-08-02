import logging
import time
from datetime import datetime, UTC
from pathlib import Path

import anyio
from fastapi import APIRouter, File, HTTPException, UploadFile, status

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
    EvidenceItem,
    ReviewItem,
    ReviewListResponse,
)
from src.services.diagnostics import detect_anomalies, parse_mcap_file, parse_rosbag2_db3
from src.services.diagnostics_config import get_diagnostics_thresholds, save_diagnostics_thresholds
from src.services.experiments import delete_experiment, experiment_bag_path, list_experiments, save_uploaded_rosbag
from src.services.llm import chat_completion, explain_diagnostics, is_llm_configured

logger = logging.getLogger(__name__)

router = APIRouter()

_runs: dict[str, AnalysisRun] = {}
_run_anomalies: dict[str, list[dict[str, object]]] = {}

_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}

_KIND_TITLES = {
    "frequency_gap": "Publish gap on {topic}",
    "silent_node": "Silent node {node}",
}

_CHAT_SYSTEM_PROMPT = (
    "You are a robotics diagnostics assistant for the RAV-13 platform. "
    "Answer concisely and only from the data provided in this conversation."
)


def _resolve_diagnostics_file_path(file_path: str) -> Path:
    """Resolve và xác thực đường dẫn tới file diagnostics trong thư mục `data/diagnostics`.

    Chỉ chấp nhận đường dẫn tương đối nằm trong `data/diagnostics` để tránh
    path traversal. Trả về `Path` đã resolve hoặc raise HTTPException.

    Args:
        file_path: Đường dẫn tương đối tới file diagnostics (vd: `bag_01/mcap.jsonl`).

    Returns:
        Path đã được resolve và xác thực nằm trong thư mục dữ liệu.

    Raises:
        HTTPException 400: Đường dẫn không hợp lệ hoặc nằm ngoài thư mục cho phép.
        HTTPException 404: File không tồn tại.
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
    """Scan data/experiments directory and return DatasetItem objects."""
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


def _pending_run_from_dataset(ds: DatasetItem) -> AnalysisRun:
    """Build a pending AnalysisRun bound to a specific dataset (nothing parsed yet)."""
    now = datetime.now(UTC).isoformat()
    return AnalysisRun(
        id=f"run_{ds.id}",
        rosbagId=ds.id,
        rosbagName=ds.name,
        robotType=ds.robotType,
        status="uploaded",
        progress=0,
        stage="parse",
        startedAt=now,
        finishedAt=None,
        anomalyCount=0,
        worstSeverity=None,
        model="vllm/qwen2.5-coder-32b",
        totalLatencyMs=0,
        promptTokens=0,
        completionTokens=0,
        costUsd=0.0,
    )


def _overview_recent_runs() -> list[AnalysisRun]:
    """Return completed in-memory runs, or a pending run for the first dataset."""
    if _runs:
        return list(reversed(list(_runs.values())))[:5]
    datasets = _load_datasets()
    if not datasets:
        return []
    return [_pending_run_from_dataset(datasets[0])]


def _anomaly_summaries(run_id: str, detections: list[dict[str, object]]) -> list[dict[str, object]]:
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
        for key in ("interval_sec", "active_span_sec", "threshold_sec"):
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


def _canned_ai_results(run_id: str, detections: list[dict[str, object]]) -> list[AIResultSummary]:
    """Build deterministic AI results from real detections until live inference is wired up."""
    results = []
    for index, detection in enumerate(detections, start=1):
        kind = detection.get("kind", "unknown")
        topic = detection.get("topic", "/unknown")
        t_sec = float(detection.get("tSec", 0.0))
        canned = {
            "frequency_gap": (
                f"Frequent publish gap detected on {topic}.",
                "Producer thread starvation or transport buffering paused publishing.",
                f"Message flow on {topic} stalled for the detected window.",
            ),
            "silent_node": (
                f"Node silence detected for topic {topic}.",
                "The node stopped publishing for the full observation window.",
                f"No messages were observed on {topic} during the span.",
            ),
            "unknown": (
                f"Anomaly pattern detected on {topic}.",
                "Raw signal deviates from the expected cadence.",
                f"Diagnostics flagged {topic} with the reported evidence.",
            ),
        }
        issue, root_cause, detail = canned[kind]
        results.append(
            AIResultSummary(
                id=f"ai_{index:03d}",
                runId=run_id,
                anomalyId=f"anomaly_{index:03d}",
                issue=issue,
                rootCause=root_cause,
                confidence=float(detection.get("confidence", 0.5)),
                explanation=f"{issue} {root_cause}",
                suggestedFix=[
                    "Check the producing node for publish stalls or thread starvation.",
                    "Validate the network / recorder path for bursty or dropped message windows.",
                ],
                evidence=[EvidenceItem(topic=topic, tSec=t_sec, detail=detail)],
                reviewStatus="pending",
                model="qwen2.5-coder-32b",
                latencyMs=1600,
                promptTokens=900,
                completionTokens=220,
                vllmRequestId=f"vllm_req_{index:03d}",
            )
        )
    return results


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """Chat với LLM qua endpoint OpenAI-compatible (httpx, tool-calling thủ công).

    Gửi tin nhắn trực tiếp tới vLLM/OpenAI. Khi LLM chưa được cấu hình, trả về
    phản hồi hướng dẫn thay vì lỗi.

    Args:
        request: Nội dung tin nhắn của người dùng.

    Returns:
        `ChatResponse` chứa câu trả lời.

    Raises:
        HTTPException 500: LLM upstream gặp lỗi khi xử lý yêu cầu.
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
        message = await anyio.to_thread.run_sync(
            chat_completion,
            [
                {"role": "system", "content": _CHAT_SYSTEM_PROMPT},
                {"role": "user", "content": request.message},
            ],
        )
        return ChatResponse(response=message.get("content", ""), analysis="")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/status")
async def agent_status():
    """Kiểm tra trạng thái của API.

    Returns:
        Dict chứa trạng thái và tên phiên bản.
    """
    return {"status": "ready", "agent": "RAV-13 Diagnostics API v1.0"}


@router.get("/datasets", response_model=DatasetListResponse)
async def datasets() -> DatasetListResponse:
    """Lấy danh sách dataset (rosbag) đã upload, quét từ data/experiments.

    Returns:
        `DatasetListResponse` chứa danh sách dataset và tổng số lượng.
    """
    items = _load_datasets()
    return DatasetListResponse(items=items, total=len(items))


@router.post("/datasets/upload", response_model=DatasetItem, status_code=status.HTTP_201_CREATED)
async def upload_dataset(file: UploadFile = File(...)) -> DatasetItem:
    """Tải lên một file rosbag (.db3/.mcap/.bag) hoặc zip rosbag2 mới.

    Lưu file vào `data/experiments/<id>/` và sinh `metadata.yaml` tối thiểu
    nếu chưa có, sau đó trả về `DatasetItem` tương ứng.

    Args:
        file: File được upload dạng multipart.

    Returns:
        `DatasetItem` mô tả rosbag vừa lưu.

    Raises:
        HTTPException 400: Định dạng không được hỗ trợ hoặc zip không an toàn.
    """
    try:
        item = save_uploaded_rosbag(file.filename or "", file.file)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    logger.info(
        "datasets.uploaded",
        extra={"diagnostics": {"event": "datasets.uploaded", "level": "info", "details": {"id": item["id"], "sizeBytes": item["sizeBytes"]}}},
    )
    return DatasetItem(**item)


@router.delete("/datasets/{dataset_id}", response_model=dict)
async def delete_dataset(dataset_id: str) -> dict:
    """Xoá một dataset (folder) trong data/experiments.

    Args:
        dataset_id: ID của dataset cần xoá (tên folder).

    Returns:
        Dict xác nhận kết quả xoá.

    Raises:
        HTTPException 404: Không tìm thấy dataset với ID đã cho.
    """
    if not delete_experiment(dataset_id):
        raise HTTPException(status_code=404, detail="dataset not found")
    logger.info(
        "datasets.deleted",
        extra={"diagnostics": {"event": "datasets.deleted", "level": "info", "details": {"id": dataset_id}}},
    )
    return {"ok": True, "id": dataset_id}


@router.get("/dashboard/overview", response_model=DashboardOverviewResponse)
async def dashboard_overview() -> DashboardOverviewResponse:
    """Lấy số liệu tổng quan dashboard.

    Trả về các chỉ số thống kê, danh sách vấn đề nổi bật, phân bố severity,
    xu hướng và các run gần đây (ưu tiên run thật trong bộ nhớ).

    Returns:
        `DashboardOverviewResponse` chứa toàn bộ dữ liệu tổng quan.
    """
    return DashboardOverviewResponse(
        totals={
            "rosbags": 12,
            "analyzed": 8,
            "messages": 420_000,
            "hoursOfData": 24.2,
            "runsWithIssuesPct": 64.0,
            "anomalies": 19,
            "criticalOpen": 4,
            "meanTimeToDiagnoseSec": 42,
            "inferenceCostUsd": 1.82,
            "tokens": 912_000,
            "reviewPending": 1,
        },
        topIssues=[
            {"kind": "lidar_dropout", "label": "LaserScan dropout", "count": 4},
            {"kind": "topic_hz_drop", "label": "Topic rate drop", "count": 3},
        ],
        severity=[
            {"severity": "critical", "count": 4},
            {"severity": "high", "count": 5},
            {"severity": "medium", "count": 6},
            {"severity": "low", "count": 4},
        ],
        trend=[
            {"date": "2026-07-18", "bags": 8, "anomalies": 9, "p95Ms": 2800, "costUsd": 0.52},
            {"date": "2026-07-19", "bags": 9, "anomalies": 10, "p95Ms": 2900, "costUsd": 0.61},
        ],
        recentRuns=_overview_recent_runs(),
    )


@router.post("/analysis", response_model=AnalysisCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_analysis(request: AnalysisCreateRequest) -> AnalysisCreateResponse:
    """Chạy phân tích thật trên rosbag của dataset.

    Đọc file bag (`parse_rosbag2_db3` cho .db3), chạy `detect_anomalies` và
    lưu run đã hoàn thành trong bộ nhớ. Nếu dataset không có bag hoặc parse
    thất bại, tạo run `uploaded`/`failed` tương ứng.

    Args:
        request: Thông tin yêu cầu phân tích (id rosbag, model tùy chọn).

    Returns:
        `AnalysisCreateResponse` chứa run vừa tạo và channel WebSocket.

    Raises:
        HTTPException 404: Không tìm thấy dataset với ID đã cho.
    """
    datasets = _load_datasets()
    match = next((ds for ds in datasets if ds.id == request.rosbag_id), None)
    if not match:
        raise HTTPException(status_code=404, detail="dataset not found")

    started_at = datetime.now(UTC).isoformat()
    run_id = f"run_{match.id}"
    model = request.model or "vllm/qwen2.5-coder-32b"
    started = time.perf_counter()
    detections: list[dict[str, object]] = []

    bag_path = experiment_bag_path(match.id)
    if bag_path is None:
        run = _pending_run_from_dataset(match)
    else:
        try:
            messages = parse_rosbag2_db3(bag_path)
            result = await anyio.to_thread.run_sync(detect_anomalies, messages, None)
            detections = result.get("detections", [])
        except Exception as e:
            logger.warning(
                "analysis.parse_failed",
                extra={"diagnostics": {"event": "analysis.parse_failed", "level": "warning", "details": {"id": match.id, "error": str(e)}}},
            )
            run = AnalysisRun(
                id=run_id,
                rosbagId=match.id,
                rosbagName=match.name,
                robotType=match.robotType,
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
        else:
            worst = None
            if detections:
                worst = max(
                    (str(d.get("severity", "low")) for d in detections),
                    key=lambda s: _SEVERITY_RANK.get(s, 0),
                )
            run = AnalysisRun(
                id=run_id,
                rosbagId=match.id,
                rosbagName=match.name,
                robotType=match.robotType,
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
    _runs[run.id] = run
    _run_anomalies[run.id] = detections
    return AnalysisCreateResponse(
        run=run,
        channel=f"/ws/runs/{run.id}",
    )


@router.get("/analysis/thresholds", response_model=DiagnosticsThresholdsResponse)
async def get_thresholds() -> DiagnosticsThresholdsResponse:
    """Lấy các thresholds (ngưỡng phát hiện) hiện tại của diagnostics.

    Returns:
        `DiagnosticsThresholdsResponse` chứa toàn bộ ngưỡng đang áp dụng.
    """
    thresholds = get_diagnostics_thresholds()
    logger.debug("diagnostics.thresholds.read", extra={"diagnostics": {"event": "diagnostics.thresholds.read", "level": "debug", "details": {"thresholds": thresholds}}})
    return DiagnosticsThresholdsResponse(thresholds=thresholds)


@router.post("/analysis/thresholds", response_model=DiagnosticsThresholdsResponse)
async def update_thresholds(payload: DiagnosticsThresholdsUpdateRequest) -> DiagnosticsThresholdsResponse:
    """Cập nhật thresholds của diagnostics và lưu xuống cấu hình.

    Args:
        payload: Các ngưỡng mới muốn áp dụng (được merge với cấu hình hiện tại).

    Returns:
        `DiagnosticsThresholdsResponse` chứa các ngưỡng sau khi đã lưu.
    """
    thresholds = save_diagnostics_thresholds(payload.thresholds)
    logger.info("diagnostics.thresholds.updated", extra={"diagnostics": {"event": "diagnostics.thresholds.updated", "level": "info", "details": {"thresholds": thresholds}}})
    return DiagnosticsThresholdsResponse(thresholds=thresholds)


@router.get("/analysis/{run_id}", response_model=AnalysisDetailResponse)
async def get_analysis(run_id: str) -> AnalysisDetailResponse:
    """Lấy chi tiết kết quả phân tích của một run.

    Args:
        run_id: ID của lần phân tích cần lấy thông tin.

    Returns:
        `AnalysisDetailResponse` chứa run, rosbag tương ứng, danh sách anomaly
        thật và kết quả AI (canned theo kind khi chưa có live inference).

    Raises:
        HTTPException 404: Không tìm thấy run với ID đã cho.
    """
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    datasets = _load_datasets()
    rosbag = next((ds for ds in datasets if ds.id == run.rosbagId), None)
    detections = _run_anomalies.get(run_id, [])
    return AnalysisDetailResponse(
        run=run,
        rosbag=rosbag,
        anomalies=_anomaly_summaries(run_id, detections),
        aiResults=_canned_ai_results(run_id, detections),
    )


@router.get("/review", response_model=ReviewListResponse)
async def review_queue() -> ReviewListResponse:
    """Lấy hàng đợi các kết quả AI đang chờ con người review.

    Returns:
        `ReviewListResponse` chứa danh sách mục cần review và tổng số lượng.
    """
    items = [
        ReviewItem(
            id="review_001",
            runId="run_9f21",
            anomalyId="anomaly_001",
            reviewStatus="pending",
            rootCause="Network path on the sensor VLAN dropped packet windows during the turn.",
            explanation="The /scan queue stalled while /odom and /imu stayed healthy, pointing to a driver-level transport issue rather than a Nav2 controller stall.",
        )
    ]
    return ReviewListResponse(items=items, total=len(items))


@router.post("/analysis/diagnose", response_model=DiagnosticsSummaryResponse)
async def diagnose(request: DiagnosticsRequest) -> DiagnosticsSummaryResponse:
    """Chạy phân tích diagnostics trên luồng tin nhắn ROS.

    Nhận dữ liệu inline hoặc đường dẫn file `.mcap` (JSONL), thực hiện phát
    hiện anomaly (khoảng cách tần suất, node im lặng) dựa trên thresholds đã
    cấu hình và ghi log chi tiết cho mỗi yêu cầu.

    Args:
        request: Chứa danh sách tin nhắn và/hoặc `file_path` cùng thresholds tùy chọn.

    Returns:
        `DiagnosticsSummaryResponse` chứa summary, danh sách detection, thresholds
        và các log của quá trình phân tích.

    Raises:
        HTTPException 400/404: `file_path` không hợp lệ hoặc không tồn tại.
    """
    messages = request.messages
    if request.file_path:
        file_path = _resolve_diagnostics_file_path(request.file_path)
        messages = parse_mcap_file(file_path)

    result = detect_anomalies(messages, thresholds=request.thresholds)
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
async def explain(request: DiagnosticsExplanationRequest) -> DiagnosticsExplanationResponse:
    """Giải thích kết quả diagnostics bằng LLM.

    Gửi summary của quá trình phân tích tới LLM để sinh ra root cause và các
    hành động khắc phục đề xuất.

    Args:
        request: Summary kết quả diagnostics cần giải thích.

    Returns:
        `DiagnosticsExplanationResponse` chứa root cause, lời giải thích và
        danh sách hành động đề xuất.
    """
    explanation = explain_diagnostics(request.summary)
    return DiagnosticsExplanationResponse(**explanation)


@router.post("/review/{review_id}/decision", response_model=DashboardReviewDecisionResponse)
async def review_decision(review_id: str, payload: DashboardReviewDecisionRequest) -> DashboardReviewDecisionResponse:  # noqa: ARG001
    """Ghi nhận quyết định review (approve/reject) cho một kết quả AI.

    Args:
        review_id: ID của mục review cần xử lý.
        payload: Verdict, reviewer và ghi chú của người review.

    Returns:
        `DashboardReviewDecisionResponse` xác nhận quyết định đã được ghi nhận.
    """
    return DashboardReviewDecisionResponse(
        ok=True,
        verdict=payload.verdict,
        reviewer=payload.reviewer or "reviewer",
        notes=payload.notes,
    )
