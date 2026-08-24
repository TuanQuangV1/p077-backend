import { backendFailure, backendGet } from "@/lib/server/backend"
import { fail, ok } from "@/lib/server/http"
import type { Rosbag } from "@/lib/types"

/** GET /api/rosbags — datasets available for analysis. */
export async function GET() {
  try {
    return ok(await backendGet<{ items: Rosbag[]; total: number }>("/datasets"))
  } catch (error) {
    const { message, status } = backendFailure(error)
    return fail(message, status)
  }
}
