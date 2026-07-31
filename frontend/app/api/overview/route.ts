import { data, KIND_LABEL, NOW, rng } from "@/lib/server/store"
import { ok } from "@/lib/server/http"
import type { AnomalyKind } from "@/lib/types"

/** GET /api/overview — dashboard aggregate. */
export async function GET() {
  const d = data()
  const analyzed = d.rosbags.filter((b) => b.status === "analyzed")
  const withIssues = d.runs.filter((r) => r.anomalyCount > 0)

  const counts = new Map<AnomalyKind, number>()
  for (const a of d.anomalies) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)
  const topIssues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => ({ kind, label: KIND_LABEL[kind], count }))

  const severity = (["critical", "high", "medium", "low"] as const).map((s) => ({
    severity: s,
    count: d.anomalies.filter((a) => a.severity === s).length,
  }))

  // 14 day trend for latency + inference cost
  const r = rng("trend")
  const trend = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(NOW - (13 - i) * 86400_000)
    const bags = 6 + Math.floor(r() * 12)
    return {
      date: day.toISOString().slice(0, 10),
      bags,
      anomalies: Math.round(bags * (0.9 + r() * 1.4)),
      p95Ms: Math.round(2600 + r() * 2400),
      costUsd: Number((bags * (0.42 + r() * 0.5)).toFixed(2)),
    }
  })

  return ok({
    totals: {
      rosbags: d.rosbags.length,
      analyzed: analyzed.length,
      messages: d.rosbags.reduce((a, b) => a + b.messageCount, 0),
      hoursOfData: Number((d.rosbags.reduce((a, b) => a + b.durationSec, 0) / 3600).toFixed(2)),
      runsWithIssuesPct: Number(((withIssues.length / Math.max(d.runs.length, 1)) * 100).toFixed(1)),
      anomalies: d.anomalies.length,
      criticalOpen: d.anomalies.filter((a) => a.severity === "critical").length,
      meanTimeToDiagnoseSec: Math.round(
        d.runs.filter((x) => x.finishedAt).reduce((a, x) => a + x.totalLatencyMs, 0) /
          Math.max(d.runs.filter((x) => x.finishedAt).length, 1) /
          1000,
      ),
      inferenceCostUsd: Number(d.runs.reduce((a, x) => a + x.costUsd, 0).toFixed(2)),
      tokens: d.runs.reduce((a, x) => a + x.promptTokens + x.completionTokens, 0),
      reviewPending: d.aiResults.filter((a) => a.reviewStatus === "pending").length,
    },
    topIssues,
    severity,
    trend,
    recentRuns: d.runs.slice(0, 6),
  })
}
