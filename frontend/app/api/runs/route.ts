import { backendFailure, backendGet, backendPost } from "@/lib/server/backend"
import { fail, ok } from "@/lib/server/http"
import type { AnalysisRun } from "@/lib/types"

/** GET /api/runs?rosbagId=&status=&limit= — analysis runs, newest first, real LLM usage per run. */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const rosbagId = url.searchParams.get("rosbagId")
  const status = url.searchParams.get("status")
  const limit = url.searchParams.get("limit") ?? "50"
  try {
    const { items: runs, total } = await backendGet<{ items: AnalysisRun[]; total: number }>(
      `/runs?limit=${encodeURIComponent(limit)}`,
    )
    const items = runs.filter(
      (run) => (!rosbagId || run.rosbagId === rosbagId) && (!status || run.status === status),
    )
    return ok({ items, total: rosbagId || status ? items.length : total })
  } catch (error) {
    const { message, status: code } = backendFailure(error)
    return fail(message, code)
  }
}

/** POST /api/runs — start an analysis run for a parsed rosbag. */
export async function POST(req: Request) {
  // The console posts `rosbag_id`; the previous handler read `rosbagId` and so
  // never found the bag. Accept either and forward the backend's own field name.
  const body = (await req.json().catch(() => ({}))) as { rosbag_id?: string; rosbagId?: string; model?: string }
  const rosbagId = body.rosbag_id ?? body.rosbagId
  if (!rosbagId) return fail("rosbag_id is required", 400)

  try {
    const result = await backendPost<{ run: AnalysisRun; channel: string }>("/analysis", {
      rosbag_id: rosbagId,
      model: body.model ?? null,
    })
    return ok(result, { status: 202 })
  } catch (error) {
    const { message, status } = backendFailure(error)
    return fail(message, status)
  }
}
