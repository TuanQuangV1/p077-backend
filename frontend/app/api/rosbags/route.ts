import { data, NOW } from "@/lib/server/store"
import { ok, readJson } from "@/lib/server/http"
import type { Rosbag } from "@/lib/types"

/** GET /api/rosbags?q=&robotType=&status=&since= */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const q = url.searchParams.get("q")?.toLowerCase() ?? ""
  const robotType = url.searchParams.get("robotType") ?? "all"
  const status = url.searchParams.get("status") ?? "all"
  const sinceHours = Number(url.searchParams.get("sinceHours") ?? 0)

  const items = data().rosbags.filter((b) => {
    if (q && !b.name.toLowerCase().includes(q) && !b.site.toLowerCase().includes(q)) return false
    if (robotType !== "all" && b.robotType !== robotType) return false
    if (status !== "all" && b.status !== status) return false
    if (sinceHours > 0 && new Date(b.recordedAt).getTime() < NOW - sinceHours * 3600_000) return false
    return true
  })

  return ok({ items, total: items.length })
}

/** POST /api/rosbags — registers an uploaded object-storage key. */
export async function POST(req: Request) {
  const body = await readJson<{ name: string; sizeBytes: number; robotType: Rosbag["robotType"] }>(req)
  const d = data()
  const id = `bag_${Math.random().toString(16).slice(2, 6)}`
  const bag: Rosbag = {
    id,
    name: body.name ?? `upload_${id}.mcap`,
    robotType: body.robotType ?? "amr-delivery",
    sizeBytes: body.sizeBytes ?? 1_200_000_000,
    durationSec: 90,
    recordedAt: new Date().toISOString(),
    uploadedAt: new Date().toISOString(),
    status: "uploaded",
    messageCount: 0,
    topics: [],
    site: "Fremont-A",
    rosVersion: "ROS 2 Jazzy",
  }
  d.rosbags.unshift(bag)
  return ok({ rosbag: bag }, { status: 201 })
}
