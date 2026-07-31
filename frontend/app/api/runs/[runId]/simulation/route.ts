import { data } from "@/lib/server/store"
import { simulationFor } from "@/lib/server/sim"
import { fail, ok } from "@/lib/server/http"

/**
 * GET /api/runs/{runId}/simulation
 * Decoded replay payload: occupancy map, pose track, lidar scans, planned path.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  const d = data()
  const run = d.runs.find((r) => r.id === runId)
  if (!run) return fail("run not found", 404)
  return ok({
    simulation: simulationFor(runId),
    anomalies: d.anomalies.filter((a) => a.runId === runId),
    aiResults: d.aiResults.filter((a) => a.runId === runId),
    run,
  })
}
