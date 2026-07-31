import { data } from "@/lib/server/store"
import { fail, ok } from "@/lib/server/http"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const d = data()
  const rosbag = d.rosbags.find((b) => b.id === id)
  if (!rosbag) return fail("rosbag not found", 404)
  const runs = d.runs.filter((r) => r.rosbagId === id)
  return ok({ rosbag, runs })
}
