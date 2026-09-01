/**
 * RAV-13 shared domain model.
 *
 * These types are the contract between the Next.js frontend and the
 * FastAPI backend (see /architecture for the SQL schema they map to).
 */

export type RobotType = "amr-delivery" | "agv-forklift" | "quadruped" | "arm-cell"

export type RosbagStatus = "uploaded" | "parsing" | "parsed" | "analyzing" | "analyzed" | "failed"

export type Severity = "critical" | "high" | "medium" | "low"

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal"

/** Anomaly kinds the real rule-based diagnostics backend (src/services/diagnostics.py) can produce. */
export type BackendAnomalyKind =
  | "frequency_gap"
  | "message_drop_burst"
  | "timestamp_jitter"
  | "silent_node"
  | "clock_drift"
  | "hz_drop"
  | "hz_drop_critical"
  | "header_latency"
  | "log_fatal"
  | "log_error_burst"
  | "log_warn_storm"
  | "payload_zero_byte"
  | "payload_nan"
  | "payload_out_of_range"
  | "tf_missing_gap"
  | "tf_drift_jump"
  | "tf_conflict"

/** Anomaly kinds used only by the local mock/demo data generator (lib/server/store.ts); the real backend never produces these. */
export type DemoAnomalyKind =
  | "tf_timeout"
  | "lidar_dropout"
  | "localization_jump"
  | "costmap_stale"
  | "cpu_spike"
  | "nav_recovery"
  | "topic_hz_drop"
  | "message_drop"

export type AnomalyKind = BackendAnomalyKind | DemoAnomalyKind

export type ReviewStatus = "pending" | "approved" | "rejected" | "edited"

export type HealthStatus = "green" | "yellow" | "red"

export interface HealthGroupScore {
  score: number
  weight: number
  detection_count: number
}

export interface HealthSummary {
  health_score: number
  status: HealthStatus
  status_zones: {
    green_min: number
    yellow_min: number
    red_max: number
  }
  trigger_llm_deep_dive: boolean
  summary: {
    total_messages: number
    total_detections: number
    worst_severity: Severity | null
    groups: Record<string, HealthGroupScore>
  }
  detections_by_group: Record<string, Anomaly[]>
}

export interface LLMDeepDiveResult {
  summary: string
  explanation: string[]
  suggestions: string[]
  confidence: number
  priority: "critical" | "high" | "medium" | "low"
  affected_components: string[]
}

export interface TopicStat {
  name: string
  messageType: string
  messageCount: number
  /** Summed serialized payload size across the recording. Absent on the
   *  dataset-metadata topic shape, which has counts but no byte totals. */
  bytesTotal?: number
  hz: number
  expectedHz: number
  dropRate: number
}

/** One time slice of the run's transport-timing profile, folded across every
 *  topic in that window from the backend's `/export/windows` NDJSON. `tSec` is
 *  relative to the recording start so it lines up with the anomaly bands. */
export interface LatencyWindow {
  tSec: number
  /** Largest inter-message gap seen on any topic in the window (ms). */
  maxGapMs: number
  /** Worst per-topic interval jitter (stdev of publish periods) in the window (ms). */
  jitterMs: number
  /** Mean |bag_time - header.stamp| across topics that carry header stamps (ms),
   *  or null when no topic in the window has header timing. */
  driftMs: number | null
}

export interface Rosbag {
  id: string
  name: string
  robotType: RobotType
  sizeBytes: number
  durationSec: number
  recordedAt: string
  uploadedAt: string
  status: RosbagStatus
  messageCount: number
  topics: TopicStat[]
  site: string
  rosVersion: string
  // Enriched at read time from the latest AnalysisRun for this rosbag.
  // `status` is always "uploaded" (upload persistence), whereas
  // analysisStatus reflects the diagnosis lifecycle.
  analysisStatus?: string | null
  analysisAnomalyCount?: number | null
  worstSeverity?: Severity | null
  lastRunId?: string | null
  duplicateOf?: string | null
}

export interface AnalysisRun {
  id: string
  rosbagId: string
  rosbagName: string
  robotType: RobotType
  status: "queued" | "running" | "succeeded" | "failed"
  progress: number
  stage: "parse" | "index" | "detect" | "diagnose" | "report" | "done"
  startedAt: string
  finishedAt: string | null
  anomalyCount: number
  worstSeverity: Severity | null
  model: string
  totalLatencyMs: number
  promptTokens: number
  completionTokens: number
  costUsd: number
}

export interface LogEvent {
  id: string
  runId: string
  tSec: number
  topic: string
  node: string
  level: LogLevel
  message: string
  anomalyId?: string
}

export interface Anomaly {
  id: string
  runId: string
  kind: AnomalyKind
  title: string
  severity: Severity
  /** Absolute simulation time from the bag. Not comparable to recording duration. */
  tSec: number
  endSec: number
  /** Seconds from the start of the recording — use these for anything plotted
   *  against duration. Optional so demo/mock data without them still type-checks. */
  tRelSec?: number
  endRelSec?: number
  topics: string[]
  confidence: number
  metric: string
  /** Rule-specific detector readings for this anomaly (`AnomalySummary.evidence`
   *  on the backend): a free-form map whose keys depend on the rule — e.g.
   *  `occurrence_count`, `cycle`, `node`, `interval_sec`, `rules`. */
  evidence?: Record<string, unknown>
}

export interface Evidence {
  topic: string
  tSec: number
  detail: string
}

/** The one conclusion that represents a whole run — ranked worst-severity then
 *  earliest (`AnalysisDetailResponse.runRootCause`). Null when the run produced
 *  no AI conclusions. `tSec` is relative to the recording start. */
export interface RunRootCause {
  rootCause: string
  explanation: string
  suggestedFix: string[]
  severity: Severity
  tSec: number
}

export interface AIResult {
  id: string
  runId: string
  anomalyId: string
  issue: string
  rootCause: string
  confidence: number
  explanation: string
  suggestedFix: string[]
  evidence: Evidence[]
  reviewStatus: ReviewStatus
  model: string
  latencyMs: number
  promptTokens: number
  completionTokens: number
  llmRequestId: string
  reviewer?: string | null
  reviewerNote?: string | null
  reviewedAt?: string | null
}

export interface ReviewStatsRun {
  runId: string
  rosbagName: string
  total: number
  reviewed: number
  approved: number
  rejected: number
  edited: number
  pending: number
  accuracy: number | null
}

export interface ReviewStats {
  total: number
  reviewed: number
  approved: number
  rejected: number
  edited: number
  pending: number
  accuracy: number | null
  runs: ReviewStatsRun[]
}

export interface Feedback {
  id: string
  aiResultId: string
  runId: string
  verdict: "approved" | "rejected" | "edited"
  editedRootCause: string | null
  notes: string
  reviewer: string
  createdAt: string
}

export interface LlmPoint {
  t: string
  tokensPerSec: number
  queueLen: number
  p50: number
  p95: number
  p99: number
  rps: number
  tokensIn: number
  tokensOut: number
}

export type LlmRequestStatus = "ok" | "timeout" | "error"

export interface LlmRequest {
  id: string
  ts: string
  runId: string | null
  route: string
  promptPreview: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  queueMs: number
  tokenizeMs: number
  prefillMs: number
  decodeMs: number
  detokenizeMs: number
  status: LlmRequestStatus
  model: string
  costUsd: number
  error?: string
}

export interface Report {
  id: string
  runId: string
  rosbagName: string
  title: string
  createdAt: string
  author: string
  status: "draft" | "published"
  summary: string
  keyIssues: { title: string; severity: Severity; rootCause: string }[]
  recommendations: string[]
  approvedCount: number
  rejectedCount: number
}

/* ---------- Simulation ---------- */

export interface OccupancyMap {
  width: number
  height: number
  resolution: number
  /** One string per row, '1' = occupied, '0' = free. */
  rows: string[]
}

export interface SimFrame {
  t: number
  x: number
  y: number
  theta: number
  v: number
  w: number
  /** Lidar ranges in meters, -1 = no return / dropped. */
  scan: number[]
  cpu: number
  degraded: AnomalyKind | null
}

export interface SimulationData {
  runId: string
  map: OccupancyMap
  scanAngleMin: number
  scanAngleMax: number
  scanRangeMax: number
  frames: SimFrame[]
  /** Ground-truth path the planner intended to follow. */
  plannedPath: { x: number; y: number }[]
  /** Second trajectory for A/B comparison (previous run on same route). */
  referencePath: { x: number; y: number }[]
}

export interface StreamEvent {
  type: "job.progress" | "log" | "llm.tick"
  ts: string
  payload: Record<string, unknown>
}
