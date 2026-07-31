import { advanceRosbag, data } from "@/lib/server/store"
import { fail, ok } from "@/lib/server/http"

/**
 * POST /api/rosbags/{id}/parse
 * In the FastAPI backend this enqueues a Celery task and returns 202 with a
 * job id the client then follows over the WebSocket channel.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const bag = data().rosbags.find((b) => b.id === id)
  if (!bag) return fail("rosbag not found", 404)
  advanceRosbag(id, "parsing")
  return ok(
    {
      jobId: `job_${Math.random().toString(16).slice(2, 8)}`,
      rosbagId: id,
      status: "parsing",
      channel: `/ws/jobs/${id}`,
    },
    { status: 202 },
  )
}
