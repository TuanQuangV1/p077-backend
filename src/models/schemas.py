from typing import Literal

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=5000, description="Tin nhắn từ user")


class ChatResponse(BaseModel):
    response: str = Field(..., description="Phản hồi từ agent")
    analysis: str = Field(default="", description="Phân tích nội bộ")


class DatasetItem(BaseModel):
    id: str
    name: str
    robotType: str
    sizeBytes: int
    durationSec: int
    recordedAt: str
    uploadedAt: str
    status: str
    messageCount: int
    topics: list[dict[str, object]] = Field(default_factory=list)
    site: str
    rosVersion: str


class DatasetListResponse(BaseModel):
    items: list[DatasetItem]
    total: int


class AnalysisRun(BaseModel):
    id: str
    rosbagId: str
    rosbagName: str
    robotType: str
    status: str
    progress: int
    stage: str
    startedAt: str
    finishedAt: str | None = None
    anomalyCount: int
    worstSeverity: str | None = None
    model: str
    totalLatencyMs: int
    promptTokens: int
    completionTokens: int
    costUsd: float


class AnomalySummary(BaseModel):
    id: str
    runId: str
    kind: str
    title: str
    severity: str
    tSec: float
    endSec: float
    topics: list[str]
    confidence: float
    metric: str


class EvidenceItem(BaseModel):
    topic: str
    tSec: float
    detail: str


class AIResultSummary(BaseModel):
    id: str
    runId: str
    anomalyId: str
    issue: str
    rootCause: str
    confidence: float
    explanation: str
    suggestedFix: list[str]
    evidence: list[EvidenceItem]
    reviewStatus: str
    model: str
    latencyMs: int
    promptTokens: int
    completionTokens: int
    vllmRequestId: str


class AnalysisDetailResponse(BaseModel):
    run: AnalysisRun
    rosbag: DatasetItem | None = None
    anomalies: list[AnomalySummary]
    aiResults: list[AIResultSummary]


class AnalysisCreateRequest(BaseModel):
    rosbag_id: str = Field(..., description="ID của rosbag cần phân tích")
    model: str | None = None


class AnalysisCreateResponse(BaseModel):
    run: AnalysisRun
    channel: str


class ReviewItem(BaseModel):
    id: str
    runId: str
    anomalyId: str
    reviewStatus: str
    rootCause: str
    explanation: str


class ReviewListResponse(BaseModel):
    items: list[ReviewItem]
    total: int


class OverviewTotals(BaseModel):
    rosbags: int
    analyzed: int
    messages: int
    hoursOfData: float
    runsWithIssuesPct: float
    anomalies: int
    criticalOpen: int
    meanTimeToDiagnoseSec: int
    inferenceCostUsd: float
    tokens: int
    reviewPending: int


class OverviewTrendPoint(BaseModel):
    date: str
    bags: int
    anomalies: int
    p95Ms: int
    costUsd: float


class OverviewTopIssue(BaseModel):
    label: str
    count: int
    kind: str | None = None


class DashboardOverviewResponse(BaseModel):
    totals: OverviewTotals
    topIssues: list[OverviewTopIssue]
    severity: list[dict[str, object]]
    trend: list[OverviewTrendPoint]
    recentRuns: list[AnalysisRun]


class DashboardReviewDecisionRequest(BaseModel):
    verdict: Literal["approved", "rejected", "edited"]
    reviewer: str | None = None
    notes: str | None = None


class DashboardReviewDecisionResponse(BaseModel):
    ok: bool
    verdict: str
    reviewer: str
    notes: str | None = None


class DiagnosticsDetection(BaseModel):
    kind: str
    topic: str
    severity: str
    confidence: float
    evidence: dict[str, object]


class DiagnosticsLogEntry(BaseModel):
    event: str
    level: str
    message: str
    details: dict[str, object]


class DiagnosticsSummary(BaseModel):
    total_messages: int
    total_detections: int
    severity: str


class DiagnosticsSummaryResponse(BaseModel):
    summary: DiagnosticsSummary
    detections: list[DiagnosticsDetection]
    thresholds: dict[str, float]
    logs: list[DiagnosticsLogEntry] = Field(default_factory=list)


class DiagnosticsRequest(BaseModel):
    messages: list[dict[str, object]] = Field(default_factory=list)
    file_path: str | None = Field(default=None, description="Optional path to a `.mcap`-style JSONL artifact for file-backed diagnostics")
    thresholds: dict[str, float] | None = Field(default=None, description="Optional runtime overrides for diagnostics thresholds")


class DiagnosticsThresholdsResponse(BaseModel):
    thresholds: dict[str, float]


class DiagnosticsThresholdsUpdateRequest(BaseModel):
    thresholds: dict[str, float]


class DiagnosticsExplanationRequest(BaseModel):
    summary: dict[str, object]


class DiagnosticsExplanationResponse(BaseModel):
    root_cause: str
    recommended_actions: list[str]
    explanation: str

