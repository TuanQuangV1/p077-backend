import { data } from "@/lib/server/store"
import { fail, ok } from "@/lib/server/http"

export const dynamic = "force-static"

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  const d = data()
  const run = d.runs.find((r) => r.id === runId)
  if (!run) return fail("run not found", 404)
  const rosbag = d.rosbags.find((b) => b.id === run.rosbagId) ?? null
  return ok({
    run,
    rosbag,
    anomalies: d.anomalies.filter((a) => a.runId === runId),
    aiResults: d.aiResults.filter((a) => a.runId === runId),
  })
}
