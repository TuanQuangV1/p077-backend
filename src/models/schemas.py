from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


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
    # Derived analysis state — not persisted with the bag, enriched at read time
    # from the latest run for this dataset (if any). Lets the registry replace
    # the always-"uploaded" upload status with a useful per-dataset diagnosis state.
    analysisStatus: str | None = Field(
        default=None,
        description="Latest analysis run status for this dataset (e.g. not_analyzed, succeeded, failed, running, queued)",
    )
    analysisAnomalyCount: int | None = Field(default=None, description="Anomaly count of the latest run")
    worstSeverity: str | None = Field(default=None, description="Worst severity of the latest run")
    lastRunId: str | None = Field(default=None, description="ID of the latest run for this dataset")
    duplicateOf: str | None = None


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
    # Seconds from the start of the recording. `tSec`/`endSec` are absolute
    # simulation time; anything plotting against recording duration wants these.
    tRelSec: float = 0.0
    endRelSec: float = 0.0
    topics: list[str]
    confidence: float
    metric: str
    evidence: dict[str, object] = Field(default_factory=dict)


class EvidenceItem(BaseModel):
    topic: str
    tSec: float
    detail: str


class AIResultSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

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
    llmRequestId: str = Field(
        default="",
        validation_alias=AliasChoices("llmRequestId", "vllmRequestId", "requestId"),
    )
    reviewer: str | None = None
    reviewerNote: str | None = None
    reviewedAt: str | None = None

    @field_validator("llmRequestId", mode="before")
    @classmethod
    def _coerce_llm_request_id(cls, v: Any) -> str:
        if v is None or v == "":
            return ""
        return str(v)

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:  # type: ignore[override]
        data = super().model_dump(**kwargs)
        # Keep both legacy keys for forward compat (frontend may read any of them)
        if self.llmRequestId:
            if "vllmRequestId" not in data:
                data["vllmRequestId"] = self.llmRequestId
            if "requestId" not in data:
                data["requestId"] = self.llmRequestId
        return data

    @property
    def requestId(self) -> str:  # compat for code that accesses .requestId
        return self.llmRequestId


class RunRootCause(BaseModel):
    """The single conclusion that represents a whole run.

    A recording with several incidents yields one conclusion each; this is the
    one ranked worst-severity-then-earliest, so the UI has a defined headline
    instead of leaving the operator to guess which incident matters.
    """

    rootCause: str
    explanation: str
    suggestedFix: list[str] = Field(default_factory=list)
    severity: str
    tSec: float
    anomalyIds: list[str] = Field(default_factory=list)


class AnalysisDetailResponse(BaseModel):
    run: AnalysisRun
    rosbag: DatasetItem | None = None
    anomalies: list[AnomalySummary]
    aiResults: list[AIResultSummary]
    health: dict[str, object] = Field(default_factory=dict)
    runRootCause: RunRootCause | None = None


class HealthSummaryResponse(BaseModel):
    health: dict[str, object]


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
    reviewer: str | None = None
    notes: str | None = None
    decidedAt: str | None = None


class ReviewStatsRun(BaseModel):
    runId: str
    rosbagName: str
    total: int
    reviewed: int
    approved: int
    rejected: int
    edited: int
    pending: int
    accuracy: float | None = None


class ReviewStatsResponse(BaseModel):
    """Human-in-the-loop verdict tallies used to measure agent accuracy.

    ``accuracy`` is approved / reviewed. Recall is deliberately absent: it needs
    ground-truth labels for anomalies the agent never reported, which the review
    queue cannot observe.
    """

    total: int
    reviewed: int
    approved: int
    rejected: int
    edited: int
    pending: int
    accuracy: float | None = None
    runs: list[ReviewStatsRun]


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


class RunListResponse(BaseModel):
    items: list[AnalysisRun]
    total: int


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
    file_path: str | None = Field(
        default=None,
        description="Optional path to a `.mcap`-style JSONL artifact for file-backed diagnostics",
    )
    thresholds: dict[str, float] | None = Field(
        default=None, description="Optional runtime overrides for diagnostics thresholds"
    )


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


class HiltIteration(BaseModel):
    iteration: int
    timestamp: str
    llm_output: dict[str, object]
    engineer_feedback: dict[str, object]


class HiltSummary(BaseModel):
    run_id: str
    anomaly_id: str
    triggered_at: str
    trigger_reasons: list[str]
    iterations: list[HiltIteration]
    diagnostic_summary: dict[str, object]
    failure_count: int


class HiltFixRequest(BaseModel):
    corrected_root_cause: str
    corrected_actions: list[str]
    notes: str | None = None


class HiltFixResponse(BaseModel):
    ok: bool
    message: str


class HiltTriggerReason(BaseModel):
    reason: str


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64, description="Tên đăng nhập")
    password: str = Field(..., min_length=1, max_length=128, description="Mật khẩu")


class LoginResponse(BaseModel):
    access_token: str = Field(..., description="JWT access token")
    token_type: str = Field(default="Bearer", description="Token type")
    expires_in: int = Field(..., description="Thời gian hết hạn tính bằng giây")
    username: str = Field(..., description="Tên user đã xác thực")


class VerifyResponse(BaseModel):
    valid: bool = Field(..., description="Token có hợp lệ không")
    username: str | None = Field(default=None, description="Username từ token nếu valid")
    expires_at: str | None = Field(default=None, description="Thời gian hết hạn ISO8601")


class LogoutResponse(BaseModel):
    ok: bool = Field(..., description="Logout thành công")
    message: str = Field(..., description="Thông báo")


class SignupRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=64, description="Tên đăng nhập")
    password: str = Field(..., min_length=6, max_length=128, description="Mật khẩu")
    confirm_password: str = Field(..., min_length=6, max_length=128, description="Xác nhận mật khẩu")


class SignupResponse(BaseModel):
    access_token: str = Field(..., description="JWT access token")
    token_type: str = Field(default="Bearer", description="Token type")
    expires_in: int = Field(..., description="Thời gian hết hạn tính bằng giây")
    username: str = Field(..., description="Tên user vừa tạo")
