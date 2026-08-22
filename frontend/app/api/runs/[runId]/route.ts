import { backendFailure, backendGet } from "@/lib/server/backend"
import { fail, ok } from "@/lib/server/http"

/** GET /api/runs/{runId} — run, its dataset, detections and AI conclusions. */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  try {
    return ok(await backendGet<Record<string, unknown>>(`/analysis/${encodeURIComponent(runId)}`))
  } catch (error) {
    const { message, status } = backendFailure(error)
    return fail(message, status)
  }
}
