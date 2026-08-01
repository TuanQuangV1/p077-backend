import type { Severity } from "./types"

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"
const API_V1_BASE = `${DEFAULT_API_BASE}/api/v1`

function resolveApiUrl(url: string): string {
    if (!url.startsWith("/api/")) return url

    const path = url.slice("/api/".length)
    const [route] = path.split("?")

    if (route === "overview") return `${API_V1_BASE}/dashboard/overview`
    if (route === "rosbags") return `${API_V1_BASE}/datasets`
    if (route === "runs") return `${API_V1_BASE}/analysis`
    if (route.startsWith("runs/")) {
        const suffix = route.slice("runs/".length)
        if (suffix.includes("/simulation")) return url
        if (suffix.includes("/timeline")) return url
        if (suffix.includes("/ai")) return url
        const [runId] = suffix.split("/")
        return `${API_V1_BASE}/analysis/${runId}`
    }
    if (route === "review") return `${API_V1_BASE}/review`
    if (route.startsWith("review/")) return `${API_V1_BASE}/${route}`
    if (route.startsWith("reports")) return url
    if (route.startsWith("vllm/")) return url
    if (route.startsWith("stream")) return url

    return url
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const target = resolveApiUrl(url)
    const res = await fetch(target, init)
    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
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
    critical: "border-critical/40 bg-critical/10 text-critical",
    high: "border-high/40 bg-high/10 text-high",
    medium: "border-medium/40 bg-medium/10 text-medium",
    low: "border-low/40 bg-low/10 text-low",
}

export const levelText: Record<string, string> = {
    fatal: "text-critical",
    error: "text-critical",
    warn: "text-medium",
    info: "text-primary",
    debug: "text-muted-foreground",
}
