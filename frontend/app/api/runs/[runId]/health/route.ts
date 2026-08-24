import { backendFailure, backendGet } from "@/lib/server/backend"
import { fail, ok } from "@/lib/server/http"
import type { HealthSummary } from "@/lib/types"

/** GET /api/runs/{runId}/health — the backend's health summary for a run.
 *
 * This used to recompute the score in the browser tier from demo anomaly kinds,
 * which disagreed with the backend and scored real runs as fully healthy.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  try {
    const payload = await backendGet<{ health: HealthSummary }>(
      `/analysis/${encodeURIComponent(runId)}/health`,
    )
    return ok(payload.health)
  } catch (error) {
    const { message, status } = backendFailure(error)
    return fail(message, status)
  }
}
