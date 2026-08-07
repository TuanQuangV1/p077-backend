import { data } from "@/lib/server/store"
import { fail, ok } from "@/lib/server/http"
import type { HealthStatus, HealthSummary, Severity } from "@/lib/types"

const HEALTH_WEIGHTS: Record<string, number> = {
  log: 0.2,
  frequency: 0.3,
  latency: 0.15,
  tf: 0.25,
  payload: 0.1,
}

const GROUP_BY_KIND: Record<string, string> = {
  tf_timeout: "frequency",
  lidar_dropout: "frequency",
  costmap_stale: "frequency",
  localization_jump: "tf",
  cpu_spike: "frequency",
  nav_recovery: "frequency",
  topic_hz_drop: "frequency",
  message_drop: "frequency",
}

const SEVERITY_PENALTY: Record<string, number> = {
  critical: 50,
  high: 30,
  medium: 15,
  low: 5,
}

const GREEN_THRESHOLD = 80
const YELLOW_THRESHOLD = 60
const DEEP_DIVE_TRIGGER_THRESHOLD = 70

function subscore(severities: string[]): number {
  let score = 100
  for (const severity of severities) {
    score -= SEVERITY_PENALTY[severity] ?? 5
  }
  return Math.max(0, Math.round(score * 10) / 10)
}

function colorZone(score: number): HealthStatus {
  if (score >= GREEN_THRESHOLD) return "green"
  if (score >= YELLOW_THRESHOLD) return "yellow"
  return "red"
}

function severityOrder(severities: string[]): Severity | null {
  const order: Severity[] = ["critical", "high", "medium", "low"]
  for (const s of order) {
    if (severities.includes(s)) return s
  }
  return null
}

/** GET /api/runs/{runId}/health */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params
  const d = data()
  const run = d.runs.find((r) => r.id === runId)
  if (!run) return fail("run not found", 404)

  const bag = d.rosbags.find((b) => b.id === run.rosbagId)
  const anomalies = d.anomalies.filter((a) => a.runId === runId)

  // Group anomalies by indicator group
  const byGroup: Record<string, typeof anomalies> = {
    log: [],
    frequency: [],
    latency: [],
    tf: [],
    payload: [],
  }

  for (const a of anomalies) {
    const group = GROUP_BY_KIND[a.kind] ?? "frequency"
    if (byGroup[group]) {
      byGroup[group].push(a)
    }
  }

  // Calculate subscores
  const subscores: Record<string, { score: number; weight: number; detection_count: number }> = {}
  for (const group of Object.keys(HEALTH_WEIGHTS)) {
    const severities = byGroup[group].map((a) => a.severity)
    subscores[group] = {
      score: subscore(severities),
      weight: HEALTH_WEIGHTS[group],
      detection_count: byGroup[group].length,
    }
  }

  // Calculate composite score
  const score = Math.round(
    Object.entries(HEALTH_WEIGHTS).reduce(
      (acc, [group, weight]) => acc + weight * (subscores[group]?.score ?? 100),
      0,
    ) * 10,
  ) / 10

  const allSeverities = anomalies.map((a) => a.severity)

  const healthSummary: HealthSummary = {
    health_score: score,
    status: colorZone(score),
    status_zones: {
      green_min: GREEN_THRESHOLD,
      yellow_min: YELLOW_THRESHOLD,
      red_max: YELLOW_THRESHOLD,
    },
    trigger_llm_deep_dive: score < DEEP_DIVE_TRIGGER_THRESHOLD,
    summary: {
      total_messages: bag?.messageCount ?? 0,
      total_detections: anomalies.length,
      worst_severity: severityOrder(allSeverities),
      groups: subscores,
    },
    detections_by_group: byGroup,
  }

  return ok(healthSummary)
}
