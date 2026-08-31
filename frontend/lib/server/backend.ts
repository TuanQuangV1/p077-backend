/**
 * Server-side client for the FastAPI backend.
 *
 * The route handlers under `app/api/` used to answer from an in-memory data
 * generator, so the console showed invented runs and anomalies while the real
 * detector output was never displayed. They call through here instead.
 *
 * Only these route handlers talk to the backend directly; browser code keeps
 * calling the same `/api/...` paths it always did, so the token (once one is
 * configured) never reaches the client bundle.
 */

const BACKEND_ORIGIN = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000"
const API_PREFIX = "/api/v1"

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "BackendError"
  }
}

async function authHeaders(incoming?: Request | Headers): Promise<Record<string, string>> {
  // Prefer incoming request's Authorization (from browser's localStorage via fetch),
  // fall back to deprecated env token for backwards compat (not used in JWT mode)
  if (incoming) {
    const h = incoming instanceof Headers ? incoming.get("authorization") : (incoming as Request).headers.get("authorization")
    if (h) return { Authorization: h }
  }
  // Also try next/headers() when called from server component without explicit Request
  try {
    const { headers } = await import("next/headers")
    const h = (await headers()).get("authorization")
    if (h) return { Authorization: h }
  } catch {}
  const token = process.env.API_AUTH_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string, init?: RequestInit & { incomingHeaders?: Headers | Request }): Promise<T> {
  const { incomingHeaders, ...restInit } = init as RequestInit & { incomingHeaders?: Headers | Request }
  let response: Response
  try {
    const auth = await authHeaders(incomingHeaders)
    response = await fetch(`${BACKEND_ORIGIN}${API_PREFIX}${path}`, {
      ...restInit,
      headers: { ...auth, ...(restInit?.headers ?? {}) },
      cache: "no-store",
    })
  } catch (cause) {
    // The backend being down is the single most common local failure; say so
    // plainly instead of surfacing an opaque fetch error in the browser.
    throw new BackendError(`backend unreachable at ${BACKEND_ORIGIN}`, 502)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new BackendError(detail || response.statusText, response.status)
  }
  return (await response.json()) as T
}

export function backendGet<T>(path: string, req?: Request): Promise<T> {
  return request<T>(path, { incomingHeaders: req?.headers } as RequestInit & { incomingHeaders?: Headers | Request })
}

export function backendPost<T>(path: string, body?: unknown, req?: Request): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    incomingHeaders: req?.headers,
  } as RequestInit & { incomingHeaders?: Headers | Request })
}

/** Map a `BackendError` onto the status/message a route handler should return. */
export function backendFailure(error: unknown): { message: string; status: number } {
  if (error instanceof BackendError) {
    return { message: error.message, status: error.status }
  }
  return { message: error instanceof Error ? error.message : "backend request failed", status: 500 }
}
