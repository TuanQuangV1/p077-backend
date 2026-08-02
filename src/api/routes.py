from datetime import datetime, UTC
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
import logging

from src.agents.graph import agent
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
from src.services.diagnostics import detect_anomalies, parse_mcap_file
from src.services.diagnostics_config import get_diagnostics_thresholds, save_diagnostics_thresholds
from src.services.llm import explain_diagnostics

logger = logging.getLogger(__name__)

router = APIRouter()


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


def _sample_datasets() -> list[DatasetItem]:
    """Trả về dữ liệu mẫu danh sách dataset (rosbag) để phục vụ UI trong lúc chưa có DB.

    Returns:
        Danh sách các `DatasetItem` mô tả rosbag đã upload.
    """
    now = datetime.now(UTC).isoformat()
    return [
        DatasetItem(
            id="bag_01",
            name="night-shift-warehouse-042.mcap",
            robotType="amr-delivery",
            sizeBytes=1_800_000_000,
            durationSec=90,
            recordedAt=now,
            uploadedAt=now,
            status="analyzed",
            messageCount=124_000,
            topics=[],
            site="Fremont-A",
            rosVersion="ROS 2 Jazzy",
        ),
        DatasetItem(
            id="bag_02",
            name="rotterdam-hub-011.mcap",
            robotType="agv-forklift",
            sizeBytes=900_000_000,
            durationSec=66,
            recordedAt=now,
            uploadedAt=now,
            status="uploaded",
            messageCount=88_000,
            topics=[],
            site="Rotterdam-1",
            rosVersion="ROS 2 Jazzy",
        ),
    ]


def _sample_run() -> AnalysisRun:
    """Tạo dữ liệu mẫu cho một lần phân tích (run) rosbag.

    Returns:
        `AnalysisRun` mẫu với trạng thái thành công và 3 anomaly.
    """
    now = datetime.now(UTC).isoformat()
    return AnalysisRun(
        id="run_9f21",
        rosbagId="bag_9f21",
        rosbagName="night-shift-warehouse-042.mcap",
        robotType="amr-delivery",
        status="succeeded",
        progress=100,
        stage="done",
        startedAt=now,
        finishedAt=now,
        anomalyCount=3,
        worstSeverity="critical",
        model="vllm/qwen2.5-coder-32b",
        totalLatencyMs=3400,
        promptTokens=1580,
        completionTokens=644,
        costUsd=0.12,
    )


def _sample_anomalies(run_id: str) -> list[dict[str, object]]:
    """Tạo danh sách anomaly mẫu gắn với một run cụ thể.

    Args:
        run_id: ID của run chứa các anomaly.

    Returns:
        Danh sách dict mô tả anomaly (kind, severity, khoảng thời gian, topics...).
    """
    return [
        {
            "id": "anomaly_001",
            "runId": run_id,
            "kind": "lidar_dropout",
            "title": "LaserScan dropout on /scan",
            "severity": "critical",
            "tSec": 14.2,
            "endSec": 16.8,
            "topics": ["/scan", "/local_costmap/costmap"],
            "confidence": 0.91,
            "metric": "0 messages for 2.20 s (expected 20 Hz)",
        },
        {
            "id": "anomaly_002",
            "runId": run_id,
            "kind": "topic_hz_drop",
            "title": "Odometry publish rate degraded",
            "severity": "medium",
            "tSec": 32.1,
            "endSec": 44.0,
            "topics": ["/odom", "/joint_states"],
            "confidence": 0.83,
            "metric": "/odom 31 Hz (expected 50 Hz)",
        },
    ]


def _sample_ai_results(run_id: str) -> list[AIResultSummary]:
    """Tạo kết quả AI phân tích mẫu (root cause, suggested fix, evidence).

    Args:
        run_id: ID của run mà các kết quả AI thuộc về.

    Returns:
        Danh sách `AIResultSummary` mẫu.
    """
    return [
        AIResultSummary(
            id="ai_001",
            runId=run_id,
            anomalyId="anomaly_001",
            issue="The primary 2D lidar stopped publishing for over two seconds.",
            rootCause="Network path on the sensor VLAN dropped packet windows during the turn.",
            confidence=0.91,
            explanation="The /scan queue stalled while /odom and /imu stayed healthy, pointing to a driver-level transport issue rather than a Nav2 controller stall.",
            suggestedFix=[
                "Isolate sensor VLAN from fleet management VLAN.",
                "Enable scan-drop recovery path in the obstacle layer.",
            ],
            evidence=[
                EvidenceItem(topic="/scan", tSec=14.2, detail="Zero messages during 2.2 s window"),
                EvidenceItem(topic="/diagnostics", tSec=14.5, detail="Driver errored on partial scan"),
            ],
            reviewStatus="pending",
            model="qwen2.5-coder-32b",
            latencyMs=1600,
            promptTokens=900,
            completionTokens=220,
            vllmRequestId="vllm_req_001",
        )
    ]


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """Chat với AI agent.

    Gửi một câu hỏi tới LangGraph agent và trả về phản hồi cùng phần phân tích
    (nếu có) được sinh ra trong quá trình chạy.

    Args:
        request: Nội dung tin nhắn của người dùng.

    Returns:
        `ChatResponse` chứa câu trả lời và kết quả phân tích.

    Raises:
        HTTPException 500: Agent gặp lỗi khi xử lý yêu cầu.
    """
    try:
        result = await agent.ainvoke({"query": request.message})
        return ChatResponse(
            response=result.get("response", ""),
            analysis=result.get("analysis", ""),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/status")
async def agent_status():
    """Kiểm tra trạng thái của agent.

    Returns:
        Dict chứa trạng thái và tên phiên bản agent.
    """
    return {"status": "ready", "agent": "LangGraph Agent v1.0"}


@router.get("/datasets", response_model=DatasetListResponse)
async def datasets() -> DatasetListResponse:
    """Lấy danh sách dataset (rosbag) đã upload.

    Returns:
        `DatasetListResponse` chứa danh sách dataset và tổng số lượng.
    """
    items = _sample_datasets()
    return DatasetListResponse(items=items, total=len(items))


@router.get("/dashboard/overview", response_model=DashboardOverviewResponse)
async def dashboard_overview() -> DashboardOverviewResponse:
    """Lấy số liệu tổng quan dashboard.

    Trả về các chỉ số thống kê (số rosbag, số anomaly, chi phí inference...),
    danh sách vấn đề nổi bật, phân bố severity, xu hướng và các run gần đây.

    Returns:
        `DashboardOverviewResponse` chứa toàn bộ dữ liệu tổng quan.
    """
    run = _sample_run()
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
        recentRuns=[run],
    )


@router.post("/analysis", response_model=AnalysisCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_analysis(request: AnalysisCreateRequest) -> AnalysisCreateResponse:  # noqa: ARG001
    """Tạo mới một lần phân tích rosbag.

    Nhận yêu cầu phân tích, tạo run và trả về kênh WebSocket để UI theo dõi
    tiến trình theo thời gian thực.

    Args:
        request: Thông tin yêu cầu phân tích (id rosbag, tham số...).

    Returns:
        `AnalysisCreateResponse` chứa run vừa tạo và channel WebSocket.
    """
    run = _sample_run()
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
        và kết quả AI phân tích.

    Raises:
        HTTPException 404: Không tìm thấy run với ID đã cho.
    """
    run = _sample_run()
    if run_id != run.id:
        raise HTTPException(status_code=404, detail="run not found")

    return AnalysisDetailResponse(
        run=run,
        rosbag=_sample_datasets()[0],
        anomalies=_sample_anomalies(run.id),
        aiResults=_sample_ai_results(run.id),
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
