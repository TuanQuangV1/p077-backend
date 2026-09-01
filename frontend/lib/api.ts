import type { Rosbag, Severity } from "./types"

export function resolveApiUrl(url: string): string {
    if (!url.startsWith("/api/")) return url

    const path = url.slice("/api/".length)
    const [route] = path.split("?")

    if (route === "overview") return "/api/v1/dashboard/overview"
    if (route === "rosbags") return "/api/v1/datasets"
    if (route.startsWith("rosbags/")) {
        const [id] = route.slice("rosbags/".length).split("/")
        return `/api/v1/datasets/${id}`
    }
    if (route === "runs") return "/api/v1/analysis"
    if (route === "analysis/explain") return "/api/v1/analysis/explain"
    if (route.startsWith("runs/")) {
        const suffix = route.slice("runs/".length)
        // `/logs` is served by a Next route handler (the backend has no raw-log
        // endpoint — log events arrive as `log_*` anomalies); everything else
        // under runs/ is the analysis detail or its `/health` sub-resource.
        if (suffix.includes("/logs")) return url
        if (suffix.includes("/health")) return `/api/v1/analysis/${suffix}`
        const [runId] = suffix.split("/")
        return `/api/v1/analysis/${runId}`
    }
    if (route === "review") return "/api/v1/review"
    if (route === "review/stats") return "/api/v1/review/stats"
    if (route.startsWith("review/")) return `/api/v1/${route}`

    return url
}

/* ---------- auth ---------- */
export interface LoginResponse {
    access_token: string
    token_type: string
    expires_in: number
    username: string
}

export interface VerifyResponse {
    valid: boolean
    username: string | null
    expires_at: string | null
}

export function getAuthToken(): string | null {
    if (typeof window === "undefined") return null
    return localStorage.getItem("auth_token")
}

export function setAuthToken(token: string, expiresInSec?: number): void {
    if (typeof window === "undefined") return
    localStorage.setItem("auth_token", token)
    // Also set cookie for middleware (server can read cookies, not localStorage)
    const maxAge = expiresInSec ?? 60 * 60
    document.cookie = `auth_token=${token}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
}

export function clearAuthToken(): void {
    if (typeof window === "undefined") return
    localStorage.removeItem("auth_token")
    document.cookie = "auth_token=; Path=/; Max-Age=0; SameSite=Lax"
}

function authHeaders(): Record<string, string> {
    const token = getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function login(username: string, password: string): Promise<LoginResponse> {
    const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null
        throw new Error(body?.detail ?? `Login failed: ${res.status}`)
    }
    const data = (await res.json()) as LoginResponse
    setAuthToken(data.access_token, data.expires_in)
    return data
}

export async function signup(username: string, password: string, confirm_password: string): Promise<LoginResponse> {
    const res = await fetch("/api/v1/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, confirm_password }),
    })
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null
        // Try to surface validation detail
        throw new Error(body?.detail ?? `Signup failed: ${res.status}`)
    }
    const data = (await res.json()) as LoginResponse
    setAuthToken(data.access_token, data.expires_in)
    return data
}

export async function verifyToken(): Promise<VerifyResponse> {
    const token = getAuthToken()
    if (!token) return { valid: false, username: null, expires_at: null }
    try {
        const res = await fetch("/api/v1/auth/verify", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return { valid: false, username: null, expires_at: null }
        return (await res.json()) as VerifyResponse
    } catch {
        return { valid: false, username: null, expires_at: null }
    }
}

export async function logout(): Promise<void> {
    const token = getAuthToken()
    if (token) {
        await fetch("/api/v1/auth/logout", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {})
    }
    clearAuthToken()
    if (typeof window !== "undefined") window.location.href = "/login"
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const target = resolveApiUrl(url)
    const headers = { ...authHeaders(), ...((init?.headers as Record<string, string>) ?? {}) }
    const res = await fetch(target, { ...init, headers })
    if (res.status === 401 && typeof window !== "undefined" && !target.includes("/auth/")) {
        clearAuthToken()
        // Avoid infinite loop if already on login
        if (window.location.pathname !== "/login") window.location.href = "/login"
        throw new Error("Session expired — redirecting to sign in page")
    }
    if (!res.ok) {
        let detail = `Request failed: ${res.status}`
        try {
            const text = await res.text()
            if (text) {
                try {
                    const parsed = JSON.parse(text) as { detail?: string }
                    detail = parsed.detail ?? text
                } catch {
                    detail = text
                }
            }
        } catch {}
        throw new Error(detail.includes("Request failed") ? detail : `Request failed: ${res.status} - ${detail}`)
    }
    return res.json() as Promise<T>
}

export async function fetcher<T>(url: string): Promise<T> {
    return requestJson<T>(url)
}

export async function post<T>(url: string, body?: unknown): Promise<T> {
    return requestJson<T>(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
    })
}

export async function del<T>(url: string): Promise<T> {
    return requestJson<T>(url, { method: "DELETE" })
}

/** One row of the backend's per-(topic, window) NDJSON summary export. */
export interface WindowSummaryRow {
    window_start: string
    topic: string
    node: string
    message_type: string
    count: number
    bytes: number
    expected_hz: number | null
    // null when the window holds fewer than 2 messages: the rate is measured
    // as (count - 1) / span, which needs at least one interval. Declaring this
    // `number` let `sum + rate` add null as 0 and silently drag a topic's
    // average rate down (window_export.py::_summarize).
    actual_hz: number | null
    // null when the window has too few messages to measure: max_gap needs one
    // interval, jitter needs two. drift is null when the stream carries no
    // header stamps.
    max_gap_ms: number | null
    jitter_ms: number | null
    drift_ms: number | null
}

/**
 * Streams the run's windowed bag summary (NDJSON, one row per topic+window).
 *
 * Kept separate from `fetcher` because the response is newline-delimited JSON,
 * not a single JSON document. The backend re-reads the whole bag per call
 * (~1s), so callers should fetch once per run rather than per view change.
 *
 * All backend calls go through the Next.js `/api/v1` rewrite (see
 * next.config.mjs), so URLs stay relative and the backend origin lives in one
 * place only.
 */
export async function fetchWindowSummaries(runId: string, windowSec = 5): Promise<WindowSummaryRow[]> {
    const res = await fetch(`/api/v1/analysis/${runId}/export/windows?window_sec=${windowSec}`, {
        headers: { ...authHeaders() },
    })
    if (res.status === 401 && typeof window !== "undefined") {
        clearAuthToken()
        if (window.location.pathname !== "/login") window.location.href = "/login"
        throw new Error("Unauthorized")
    }
    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
    const body = await res.text()
    return body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as WindowSummaryRow)
}

/** Uploads a rosbag file (or rosbag2 zip) to the backend via multipart. */
export async function uploadRosbag(file: File): Promise<Rosbag> {
    const form = new FormData()
    form.append("file", file)
    const base = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/+$/, "")
    const target = base ? `${base}/api/v1/datasets/upload` : "/api/v1/datasets/upload"
    const res = await fetch(target, {
        method: "POST",
        headers: { ...authHeaders() },
        body: form,
    })
    if (res.status === 401 && typeof window !== "undefined") {
        clearAuthToken()
        if (window.location.pathname !== "/login") window.location.href = "/login"
        throw new Error("Unauthorized")
    }
    if (!res.ok) {
        let detail = `HTTP error ${res.status}`
        try {
            const text = await res.text()
            if (text) {
                try {
                    const j = JSON.parse(text) as { detail?: string }
                    detail = j.detail ?? text
                } catch {
                    detail = text
                }
            }
        } catch {}
        throw new Error(detail)
    }
    return res.json() as Promise<Rosbag>
}

/* ---------- formatting ---------- */

export function bytes(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`
    return `${n} B`
}

export function compact(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
    return String(n)
}

/** 63.412 -> "1:03.412" — the clock format used across timeline and replay. */
export function clock(tSec: number, ms = true): string {
    const sign = tSec < 0 ? "-" : ""
    const t = Math.abs(tSec)
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    const frac = Math.round((t % 1) * 1000)
    const base = `${sign}${m}:${String(s).padStart(2, "0")}`
    return ms ? `${base}.${String(frac).padStart(3, "0")}` : base
}

export function ms(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}

export function timeOfDay(iso: string): string {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false })
}

export function shortDate(iso: string): string {
    return new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    })
}

export function ago(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.round(diff / 60000)
    if (mins < 1) return "just now"
    if (mins < 60) return `${mins}m ago`
    const hours = Math.round(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
}

/* ---------- severity ---------- */

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"]

/** Severity is the one place colour carries meaning, so it is centralised. */
export const severityColor: Record<Severity, string> = {
    critical: "var(--severity-critical)",
    high: "var(--severity-high)",
    medium: "var(--severity-medium)",
    low: "var(--severity-low)",
}

export const severityText: Record<Severity, string> = {
    critical: "text-critical",
    high: "text-high",
    medium: "text-medium",
    low: "text-low",
}

export const severityBorder: Record<Severity, string> = {
    critical: "border-rose-500/30 bg-rose-500/8 text-rose-400/90",
    high: "border-amber-500/30 bg-amber-500/8 text-amber-400/90",
    medium: "border-slate-400/30 bg-slate-400/8 text-slate-400/90",
    low: "border-slate-500/20 bg-slate-500/5 text-slate-500/80",
}

export const levelText: Record<string, string> = {
    fatal: "text-critical",
    error: "text-critical",
    warn: "text-medium",
    info: "text-primary",
    debug: "text-muted-foreground",
}
