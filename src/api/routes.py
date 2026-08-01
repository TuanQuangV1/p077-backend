from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, status

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
    EvidenceItem,
    ReviewItem,
    ReviewListResponse,
)
from src.services.diagnostics import detect_anomalies, parse_mcap_file
from src.services.llm import explain_diagnostics

router = APIRouter()


def _resolve_diagnostics_file_path(file_path: str) -> Path:
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
    now = datetime.now(timezone.utc).isoformat()
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
    now = datetime.now(timezone.utc).isoformat()
    return AnalysisRun(
        id="run_001",
        rosbagId="bag_01",
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
    """Chat với AI agent."""
    try:
        result = await agent.ainvoke({"query": request.message})
        return ChatResponse(
            response=result.get("response", ""),
            analysis=result.get("analysis", ""),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def agent_status():
    """Kiểm tra trạng thái agent."""
    return {"status": "ready", "agent": "LangGraph Agent v1.0"}


@router.get("/datasets", response_model=DatasetListResponse)
async def datasets() -> DatasetListResponse:
    items = _sample_datasets()
    return DatasetListResponse(items=items, total=len(items))


@router.get("/dashboard/overview", response_model=DashboardOverviewResponse)
async def dashboard_overview() -> DashboardOverviewResponse:
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
async def create_analysis(request: AnalysisCreateRequest) -> AnalysisCreateResponse:
    run = _sample_run()
    return AnalysisCreateResponse(
        run=run,
        channel=f"/ws/runs/{run.id}",
    )


@router.get("/analysis/{run_id}", response_model=AnalysisDetailResponse)
async def get_analysis(run_id: str) -> AnalysisDetailResponse:
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
    items = [
        ReviewItem(
            id="review_001",
            runId="run_001",
            anomalyId="anomaly_001",
            reviewStatus="pending",
            rootCause="Network path on the sensor VLAN dropped packet windows during the turn.",
            explanation="The /scan queue stalled while /odom and /imu stayed healthy, pointing to a driver-level transport issue rather than a Nav2 controller stall.",
        )
    ]
    return ReviewListResponse(items=items, total=len(items))


@router.post("/analysis/diagnose", response_model=DiagnosticsSummaryResponse)
async def diagnose(request: DiagnosticsRequest) -> DiagnosticsSummaryResponse:
    messages = request.messages
    if request.file_path:
        file_path = _resolve_diagnostics_file_path(request.file_path)
        messages = parse_mcap_file(file_path)
    result = detect_anomalies(messages)
    return DiagnosticsSummaryResponse(**result)


@router.post("/analysis/explain", response_model=DiagnosticsExplanationResponse)
async def explain(request: DiagnosticsExplanationRequest) -> DiagnosticsExplanationResponse:
    explanation = explain_diagnostics(request.summary)
    return DiagnosticsExplanationResponse(**explanation)


@router.post("/review/{review_id}/decision", response_model=DashboardReviewDecisionResponse)
async def review_decision(review_id: str, payload: DashboardReviewDecisionRequest) -> DashboardReviewDecisionResponse:
    return DashboardReviewDecisionResponse(
        ok=True,
        verdict=payload.verdict,
        reviewer=payload.reviewer or "reviewer",
        notes=payload.notes,
    )
