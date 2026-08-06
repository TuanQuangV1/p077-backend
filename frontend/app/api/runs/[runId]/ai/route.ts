import { data } from "@/lib/server/store"
import { ok } from "@/lib/server/http"

/** GET /api/runs/{runId}/ai — agent conclusions with evidence + review state. */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  const d = data()
  const items = d.aiResults.filter((a) => a.runId === runId)
  const requests = d.vllmRequests.filter((r) => r.runId === runId).slice(0, 12)
  return ok({ items, inference: requests })
}
