import { data } from "@/lib/server/store"
import { ok } from "@/lib/server/http"

/** GET /api/vllm/requests?status=&runId=&limit= */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const status = url.searchParams.get("status") ?? "all"
  const runId = url.searchParams.get("runId")
  const limit = Number(url.searchParams.get("limit") ?? 60)

  const all = data().vllmRequests
  const items = all
    .filter((r) => (status === "all" ? true : status === "errors" ? r.status !== "ok" : r.status === status))
    .filter((r) => (runId ? r.runId === runId : true))
    .slice(0, limit)

  const errors = all.filter((r) => r.status !== "ok")
  return ok({
    items,
    total: all.length,
    errorRate: Number(((errors.length / all.length) * 100).toFixed(2)),
    costUsd24h: Number(all.reduce((a, r) => a + r.costUsd, 0).toFixed(2)),
    tokens24h: all.reduce((a, r) => a + r.promptTokens + r.completionTokens, 0),
  })
}
