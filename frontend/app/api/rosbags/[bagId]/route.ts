import { backendFailure, BackendError } from "@/lib/server/backend"
import { fail, ok } from "@/lib/server/http"

const BACKEND_ORIGIN = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000"

/** DELETE /api/rosbags/{bagId} — remove an uploaded dataset. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ bagId: string }> }) {
  const { bagId } = await params
  try {
    // Forward Authorization from incoming request (localStorage via header) or fallback to env
    let authHeader = _req.headers.get("authorization")
    if (!authHeader) {
      try {
        const { headers } = await import("next/headers")
        authHeader = (await headers()).get("authorization") ?? null
      } catch {}
    }
    if (!authHeader) {
      const token = process.env.API_AUTH_TOKEN
      if (token) authHeader = `Bearer ${token}`
    }
    const response = await fetch(
      `${BACKEND_ORIGIN}/api/v1/datasets/${encodeURIComponent(bagId)}`,
      {
        method: "DELETE",
        headers: authHeader ? { Authorization: authHeader } : {},
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
