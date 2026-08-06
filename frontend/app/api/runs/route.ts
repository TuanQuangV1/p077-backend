import { data } from "@/lib/server/store"
import { fail, ok, readJson } from "@/lib/server/http"
import type { AnalysisRun } from "@/lib/types"

/** GET /api/runs?rosbagId=&status= */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const rosbagId = url.searchParams.get("rosbagId")
  const status = url.searchParams.get("status")
  const items = data().runs.filter(
    (r) => (!rosbagId || r.rosbagId === rosbagId) && (!status || r.status === status),
  )
  return ok({ items, total: items.length })
}

/** POST /api/runs — start an analysis run for a parsed rosbag. */
export async function POST(req: Request) {
  const body = await readJson<{ rosbagId: string; model?: string }>(req)
  const d = data()
  const bag = d.rosbags.find((b) => b.id === body.rosbagId)
  if (!bag) return fail("rosbag not found", 404)

  const run: AnalysisRun = {
    id: `run_${Math.random().toString(16).slice(2, 6)}`,
    rosbagId: bag.id,
    rosbagName: bag.name,
    robotType: bag.robotType,
    status: "running",
    progress: 4,
    stage: "parse",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    anomalyCount: 0,
    worstSeverity: null,
    model: body.model ?? "vllm/qwen2.5-coder-32b",
    totalLatencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  }
  d.runs.unshift(run)
  bag.status = "analyzing"
  return ok({ run, channel: `/ws/runs/${run.id}` }, { status: 202 })
}
