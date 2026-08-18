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

export type AnomalyKind =
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
  | "tf_missing_gap"
  | "tf_drift_jump"

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
  hz: number
  expectedHz: number
  dropRate: number
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
  tSec: number
  endSec: number
  topics: string[]
  confidence: number
  metric: string
}

export interface Evidence {
  topic: string
  tSec: number
  detail: string
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
  vllmRequestId: string
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

export interface VllmPoint {
  t: string
  gpuUtil: number
  vramUsedGb: number
  tokensPerSec: number
  batchSize: number
  queueLen: number
  p50: number
  p95: number
  p99: number
  rps: number
  tokensIn: number
  tokensOut: number
}

export type VllmRequestStatus = "ok" | "timeout" | "oom" | "error"

export interface VllmRequest {
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
  status: VllmRequestStatus
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
  type: "job.progress" | "log" | "vllm.tick"
  ts: string
  payload: Record<string, unknown>
}
