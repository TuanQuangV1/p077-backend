import { backendFailure, BackendError } from "@/lib/server/backend"
import { fail, ok } from "@/lib/server/http"

const BACKEND_ORIGIN = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000"

/** DELETE /api/rosbags/{bagId} — remove an uploaded dataset. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ bagId: string }> }) {
  const { bagId } = await params
  try {
    const token = process.env.API_AUTH_TOKEN
    const response = await fetch(
      `${BACKEND_ORIGIN}/api/v1/datasets/${encodeURIComponent(bagId)}`,
      {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      },
    )
    if (!response.ok) {
      throw new BackendError(await response.text().catch(() => response.statusText), response.status)
    }
    return ok(await response.json().catch(() => ({ ok: true })))
  } catch (error) {
    const { message, status } = backendFailure(error)
    return fail(message, status)
  }
}
