import { data } from "@/lib/server/store"
import { fail, ok } from "@/lib/server/http"

/**
 * GET /api/runs/{runId}/timeline?topics=/scan,/tf&from=0&to=60&levels=warn,error
 *
 * Returns everything the timeline canvas needs in one round trip: lane
 * definitions with per-bucket message density, anomaly bands and the log
 * events inside the requested window.
 */
export const dynamic = "force-static"

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  const url = new URL(req.url)
  const d = data()
  const run = d.runs.find((r) => r.id === runId)
  if (!run) return fail("run not found", 404)
  const bag = d.rosbags.find((b) => b.id === run.rosbagId)
  const durationSec = bag?.durationSec ?? 90

  const from = Number(url.searchParams.get("from") ?? 0)
  const to = Number(url.searchParams.get("to") ?? durationSec)
  const topicFilter = url.searchParams.get("topics")?.split(",").filter(Boolean) ?? []
  const levelFilter = url.searchParams.get("levels")?.split(",").filter(Boolean) ?? []

  const anomalies = d.anomalies.filter((a) => a.runId === runId)
  const logs = d.logs.filter(
    (l) =>
      l.runId === runId &&
      l.tSec >= from &&
      l.tSec <= to &&
      (topicFilter.length === 0 || topicFilter.includes(l.topic)) &&
      (levelFilter.length === 0 || levelFilter.includes(l.level)),
  )

  const BUCKETS = 240

  // Pre-compute anomaly intervals per topic for O(1) bucket lookup
  const anomalyIntervalsByTopic = new Map<string, { start: number; end: number }[]>()
  for (const a of anomalies) {
    for (const topic of a.topics) {
      const arr = anomalyIntervalsByTopic.get(topic) ?? []
      arr.push({ start: a.tSec, end: a.endSec })
      anomalyIntervalsByTopic.set(topic, arr)
    }
  }
  // Sort intervals for binary search
  for (const intervals of anomalyIntervalsByTopic.values()) {
    intervals.sort((x, y) => x.start - y.start)
  }

  function hasAnomalyAt(topic: string, tSec: number): boolean {
    const intervals = anomalyIntervalsByTopic.get(topic)
    if (!intervals) return false
    // Binary search since intervals are sorted by start
    let lo = 0
    let hi = intervals.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const iv = intervals[mid]
      if (tSec < iv.start) hi = mid - 1
      else if (tSec > iv.end) lo = mid + 1
      else return true
    }
    return false
  }

  const lanes = (bag?.topics ?? []).map((t) => {
    const density = new Array(BUCKETS).fill(0)
    const perBucket = (t.hz * durationSec) / BUCKETS
    for (let i = 0; i < BUCKETS; i++) {
      const tSec = (i / BUCKETS) * durationSec
      const hit = hasAnomalyAt(t.name, tSec)
      const noise = 0.88 + ((i * 2654435761) % 1000) / 4000
      density[i] = Math.max(0, Math.round(perBucket * noise * (hit ? 0.15 : 1)))
    }
    return { topic: t.name, messageType: t.messageType, expectedHz: t.expectedHz, hz: t.hz, density }
  })

  return ok({
    runId,
    durationSec,
    buckets: BUCKETS,
    lanes,
    anomalies,
    logs,
    logTotal: logs.length,
  })
}
