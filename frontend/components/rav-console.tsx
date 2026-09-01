"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
    ActivityIcon, ArrowRightIcon, BotIcon, CircleAlertIcon,
    CpuIcon, DatabaseIcon, DownloadIcon, FileTextIcon, GaugeIcon,
    PlayIcon, RefreshCwIcon, SearchIcon, ServerIcon, ShieldCheckIcon,
    SkipBackIcon, SkipForwardIcon, Trash2Icon, UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

import { AIConclusion } from "@/components/ai-conclusion"
import { AnalysisControlBar } from "@/components/analysis/analysis-control-bar"
import { AnomalyList } from "@/components/analysis/anomaly-list"
import { TimelineCanvas, type Lane } from "@/components/analysis/timeline-canvas"
import { MetaRow, PageHeader, SectionCard, SeverityBadge, StatTile, StatusLabel } from "@/components/telemetry"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { bytes, clock, compact, del, fetchWindowSummaries, fetcher, ms, post, uploadRosbag, type WindowSummaryRow } from "@/lib/api"
import { relativeSpan } from "@/lib/anomaly-groups"
import type { AIResult, Anomaly, AnalysisRun, LatencyWindow, LogEvent, ReviewStats, Rosbag, RunRootCause, Severity, TopicStat } from "@/lib/types"

import { AnalysisHealthPanel } from "@/components/health/analysis-health-panel"
import { LLMObservability } from "@/components/llm/llm-observability"
import { HealthBadge } from "@/components/health/health-gauge"
import { DashboardOverview } from "@/components/dashboard/dashboard-overview"
import { CaptureRegistry } from "@/components/datasets/capture-registry"
import type { HealthSummary } from "@/lib/types"

type Overview = { totals: Record<string, number>; topIssues: { label: string; count: number }[]; severity: { severity: string; count: number }[]; trend: { date: string; bags: number; anomalies: number; p95Ms: number; costUsd: number }[]; recentRuns: AnalysisRun[] }

const json = (value: unknown) => JSON.stringify(value, null, 2)

const TIMELINE_WINDOW_SEC = 5
const TIMELINE_BUCKETS = 240

/**
 * Folds the backend's per-(topic, window) summary rows into canvas lanes.
 *
 * `window_start` is absolute bag time (a bag may start at t=358s), but every
 * other time in this view — `relativeSpan`, `rosbag.durationSec`, the seconds
 * the LLM narrates — is relative to the first message. Rebasing on `originAbs`
 * (a detection's `tSec - tRelSec`) keeps the canvas on one clock; without it the
 * density bars drew hundreds of seconds to the right of the anomaly bands.
 */
function buildTimelineLanes(
    rows: WindowSummaryRow[],
    windowSec: number,
    originAbs: number | null,
    recordingSec: number,
): { lanes: Lane[]; durationSec: number; startSec: number } {
    if (rows.length === 0) return { lanes: [], durationSec: 0, startSec: 0 }
    const absStartOf = (row: WindowSummaryRow) => Date.parse(row.window_start) / 1000
    const origin = originAbs ?? Math.min(...rows.map(absStartOf))
    const startOf = (row: WindowSummaryRow) => absStartOf(row) - origin
    const startSec = 0
    const durationSec = recordingSec > 0
        ? recordingSec
        : Math.max(...rows.map((row) => startOf(row) + windowSec))

    const byTopic = new Map<string, WindowSummaryRow[]>()
    for (const row of rows) {
        const bucket = byTopic.get(row.topic)
        if (bucket) bucket.push(row)
        else byTopic.set(row.topic, [row])
    }

    const lanes = [...byTopic.entries()]
        .map(([topic, topicRows]) => {
            const density = new Array<number>(TIMELINE_BUCKETS).fill(0)
            for (const row of topicRows) {
                const start = startOf(row)
                const from = Math.max(0, Math.floor((start / durationSec) * TIMELINE_BUCKETS))
                const to = Math.min(TIMELINE_BUCKETS - 1, Math.floor(((start + windowSec) / durationSec) * TIMELINE_BUCKETS))
                for (let b = from; b <= to; b++) density[b] = Math.max(density[b], row.count)
            }
            const meanHz = topicRows.reduce((sum, row) => sum + row.actual_hz, 0) / topicRows.length
            return {
                topic,
                messageType: topicRows[0].message_type,
                expectedHz: topicRows[0].expected_hz ?? 0,
                hz: Number(meanHz.toFixed(2)),
                density,
            }
        })
        .sort((a, b) => a.topic.localeCompare(b.topic))

    return { lanes, durationSec, startSec }
}

/**
 * Per-topic stats for the Topic Health table, from the same window rows.
 */
function buildTopicStats(rows: WindowSummaryRow[]): TopicStat[] {
    const byTopic = new Map<string, WindowSummaryRow[]>()
    for (const row of rows) {
        const bucket = byTopic.get(row.topic)
        if (bucket) bucket.push(row)
        else byTopic.set(row.topic, [row])
    }

    return [...byTopic.entries()]
        .map(([topic, topicRows]) => {
            const rates = topicRows.map((row) => row.actual_hz)
            const expectedHz = topicRows[0].expected_hz ?? Math.max(...rates)
            const hz = rates.reduce((sum, rate) => sum + rate, 0) / rates.length
            return {
                name: topic,
                messageType: topicRows[0].message_type,
                messageCount: topicRows.reduce((sum, row) => sum + row.count, 0),
                bytesTotal: topicRows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
                hz: Number(hz.toFixed(2)),
                expectedHz: Number(expectedHz.toFixed(2)),
                dropRate: expectedHz > 0 ? Math.max(0, Number((1 - hz / expectedHz).toFixed(4))) : 0,
            }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Folds the window rows into one transport-timing slice per time bucket for the
 * Latency & Jitter panel. Each slice takes the worst gap/jitter across topics
 * (one bad topic is what the panel exists to surface) and the mean absolute
 * clock drift. `window_start` is absolute bag time, rebased on `originAbs` — the
 * same anchor `buildTimelineLanes` uses — so the buckets align with the anomaly
 * bands.
 */
function buildLatencyWindows(rows: WindowSummaryRow[], originAbs: number | null): LatencyWindow[] {
    if (rows.length === 0) return []
    const absStartOf = (row: WindowSummaryRow) => Date.parse(row.window_start) / 1000
    const origin = originAbs ?? Math.min(...rows.map(absStartOf))

    const byWindow = new Map<number, WindowSummaryRow[]>()
    for (const row of rows) {
        const tSec = Math.round(absStartOf(row) - origin)
        const bucket = byWindow.get(tSec)
        if (bucket) bucket.push(row)
        else byWindow.set(tSec, [row])
    }

    return [...byWindow.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([tSec, group]) => {
            const drifts = group.map((row) => row.drift_ms).filter((d): d is number => d != null)
            return {
                tSec,
                maxGapMs: Math.max(0, ...group.map((row) => row.max_gap_ms ?? 0)),
                jitterMs: Math.max(0, ...group.map((row) => row.jitter_ms ?? 0)),
                driftMs: drifts.length
                    ? drifts.reduce((sum, d) => sum + Math.abs(d), 0) / drifts.length
                    : null,
            }
        })
}

export function RavConsole() {
    const pathname = usePathname()
    const router = useRouter()
    const rawSection = pathname === "/" ? "dashboard" : pathname.split("/")[1] || "dashboard"
    const section = rawSection === "llm-monitoring" ? "llm" : rawSection
    const [overview, setOverview] = useState<Overview | null>(null)
    const [bags, setBags] = useState<Rosbag[]>([])
    const [activeRun, setActiveRun] = useState<AnalysisRun | null>(null)
    const [anomalies, setAnomalies] = useState<Anomaly[]>([])
    const [aiResults, setAiResults] = useState<AIResult[]>([])
    const [runRootCause, setRunRootCause] = useState<RunRootCause | null>(null)
    const [logs, setLogs] = useState<LogEvent[]>([])
    const [llmRuns, setLlmRuns] = useState<AnalysisRun[]>([])
    const [llmRunsTotal, setLlmRunsTotal] = useState(0)
    const [selected, setSelected] = useState<string | null>(null)
    const [playhead, setPlayhead] = useState(42.8)
    const [thresholds, setThresholds] = useState<Record<string, number>>({})
    const [savingThresholds, setSavingThresholds] = useState(false)
    const [timelineView, setTimelineView] = useState({ from: 0, to: 120 })
    const [windowRows, setWindowRows] = useState<WindowSummaryRow[]>([])
    const [topicFilter, setTopicFilter] = useState("all")
    const [timeRange, setTimeRange] = useState("all")

    const refreshBags = (isCancelled: () => boolean = () => false) => {
        fetcher<{ items: Rosbag[] }>("/api/rosbags")
            .then((x) => { if (!isCancelled()) setBags(x.items) })
            .catch(() => { if (!isCancelled()) toast.error("Unable to load ROSBag datasets") })
    }

    useEffect(() => {
        let cancelled = false
        const isCancelled = () => cancelled
        fetcher<Overview>("/api/overview")
            .then((x) => { if (!cancelled) setOverview(x) })
            .catch(() => { if (!cancelled) toast.error("Unable to load fleet overview") })
        refreshBags(isCancelled)
        return () => { cancelled = true }
    }, [])
    // Which run's detail is loaded or in flight. A ref, not `activeRun`: this
    // effect calls `setActiveRun` itself, so depending on that state made the
    // effect re-run and its own cleanup cancel the fetch it had just started —
    // every anomaly, AI result and root cause was discarded before it rendered.
    const loadedRunRef = useRef<string | null>(null)
    useEffect(() => {
        const run = overview?.recentRuns?.find((x) => x.status === "succeeded") ?? overview?.recentRuns?.[0]
        if (!run || loadedRunRef.current === run.id) return
        loadedRunRef.current = run.id
        setActiveRun(run)
        Promise.all([
            fetcher<{ anomalies: Anomaly[]; aiResults: AIResult[]; runRootCause: RunRootCause | null }>(`/api/runs/${run.id}`),
            fetcher<{ logs: LogEvent[] }>(`/api/runs/${run.id}/logs`).catch(() => ({ logs: [] as LogEvent[] })),
          ]).then(([detail, logsData]) => {
            // A different run was selected while this was in flight.
            if (loadedRunRef.current !== run.id) return
            setAnomalies(detail.anomalies)
            setAiResults(detail.aiResults)
            setRunRootCause(detail.runRootCause)
            setLogs(logsData.logs)
            setSelected(detail.anomalies[0]?.id ?? null)
          })
    }, [overview])

    useEffect(() => {
        if (section !== "analysis" || !activeRun) return
        let cancelled = false
        fetchWindowSummaries(activeRun.id, TIMELINE_WINDOW_SEC)
            .then((rows) => { if (!cancelled) setWindowRows(rows) })
            .catch(() => { if (!cancelled) setWindowRows([]) })
        return () => { cancelled = true }
    }, [section, activeRun])

    // A detection carries both clocks, so `tSec - tRelSec` is the recording
    // origin in absolute bag time — the anchor that puts window rows, anomaly
    // bands and the LLM narrative on the same relative axis.
    const activeBag = bags.find((b) => b.id === activeRun?.rosbagId) ?? null
    const recordingSec = activeBag?.durationSec ?? 0
    const recordingOrigin = useMemo(() => {
        const anchored = anomalies.find((a) => a.tRelSec !== undefined)
        return anchored ? anchored.tSec - (anchored.tRelSec ?? 0) : null
    }, [anomalies])
    const { lanes: timelineLanes, durationSec: timelineDuration, startSec: timelineStart } = useMemo(
        () => buildTimelineLanes(windowRows, TIMELINE_WINDOW_SEC, recordingOrigin, recordingSec),
        [windowRows, recordingOrigin, recordingSec],
    )
    const topicStats = useMemo(() => buildTopicStats(windowRows), [windowRows])
    const latencyWindows = useMemo(
        () => buildLatencyWindows(windowRows, recordingOrigin),
        [windowRows, recordingOrigin],
    )
    useEffect(() => {
        if (timelineDuration > 0) setTimelineView({ from: 0, to: timelineDuration })
    }, [timelineDuration])

    // `/api/v1/runs` is the real list endpoint (proxied straight through by
    // next.config). `/api/runs` would be rewritten to `/api/v1/analysis` by
    // resolveApiUrl, which is POST-only — a GET there 405s and the list stays empty.
    const loadLlmRuns = (isCancelled: () => boolean = () => false) =>
        fetcher<{ items: AnalysisRun[]; total: number }>('/api/v1/runs?limit=200')
            .then((x) => { if (!isCancelled()) { setLlmRuns(x.items); setLlmRunsTotal(x.total) } })
            .catch(() => { if (!isCancelled()) { setLlmRuns([]); setLlmRunsTotal(0) } })
    useEffect(() => {
        if (section !== "llm") return
        let cancelled = false
        loadLlmRuns(() => cancelled)
        return () => { cancelled = true }
    }, [section])
    useEffect(() => {
        if (section !== "analysis") return
        let cancelled = false
        fetcher<{ thresholds: Record<string, number> }>('/api/v1/analysis/thresholds')
            .then((payload) => { if (!cancelled) setThresholds(payload.thresholds) })
            .catch(() => { if (!cancelled) toast.error('Unable to load threshold configuration') })
        return () => { cancelled = true }
    }, [section])

    const selectedAnomaly = anomalies.find((a) => a.id === selected) ?? anomalies[0]
    const selectedResult = aiResults.find((r) => r.anomalyId === selectedAnomaly?.id) ?? aiResults[0]
    const navigate = (href: string) => router.push(href)
    const handleReviewed = (updated: AIResult) => setAiResults((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    const title = ({ dashboard: "Fleet Overview", datasets: "ROSBag Registry", analysis: "Diagnostics Workspace", review: "Human Review", reports: "Diagnostic Reports", llm: "LLM Observability", architecture: "System Architecture" } as Record<string, string>)[section] ?? "RAV-13"

    return <main className="min-h-[calc(100vh-3rem)] bg-background p-4 md:p-6"><div className="mx-auto flex max-w-[1800px] flex-col gap-5">
        <PageHeader title={title} description={section === "analysis" ? `${activeRun?.rosbagName ?? "Select a run"} · Synchronized Diagnostics Surface` : "ROS2 Doctor + LLM Agent Telemetry Platform"} actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => window.location.reload()} className="cursor-pointer"><RefreshCwIcon data-icon="inline-start" />Refresh</Button>{section === "datasets" ? <Button size="sm" onClick={() => refreshBags()} className="cursor-pointer"><UploadIcon data-icon="inline-start" />Refresh List</Button> : null}</div>} />
        {section === "dashboard" && <DashboardOverview overview={overview} navigate={navigate} />}
        {/* Dataset Registry Surface (Actions: "Diagnose Selected", "Upload ROSBag", "Filter by bag name") */}
        {section === "datasets" && <CaptureRegistry bags={bags} onRefresh={() => refreshBags()} navigate={navigate} />}
        {section === "analysis" && <AnalysisWorkspace activeRun={activeRun} rosbag={activeBag} anomalies={anomalies} logs={logs} selected={selected} setSelected={setSelected} lanes={timelineLanes} playhead={playhead} setPlayhead={setPlayhead} selectedResult={selectedResult} view={timelineView} setView={setTimelineView} topicFilter={topicFilter} setTopicFilter={setTopicFilter} timeRange={timeRange} setTimeRange={setTimeRange} thresholds={thresholds} setThresholds={setThresholds} savingThresholds={savingThresholds} setSavingThresholds={setSavingThresholds} onReviewed={handleReviewed} durationSec={timelineDuration} startSec={timelineStart} topics={topicStats} latencyWindows={latencyWindows} runRootCause={runRootCause} />}
        {section === "review" && <Review results={aiResults} anomalies={anomalies} onReviewed={handleReviewed} />}
        {section === "reports" && <ReportsEnhanced activeRun={activeRun} />}
        {section === "llm" && <LLMObservability runs={llmRuns} total={llmRunsTotal} onRefresh={() => loadLlmRuns()} />}
        {section === "architecture" && <Architecture />}
    </div></main>
}

function Review({ results, anomalies, onReviewed }: { results: AIResult[]; anomalies: Anomaly[]; onReviewed: (result: AIResult) => void }) {
    const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected" | "edited">("all")
    const filtered = filter === "all" ? results : results.filter((r) => r.reviewStatus === filter)

    const pending = results.filter((r) => r.reviewStatus === "pending").length
    const approved = results.filter((r) => r.reviewStatus === "approved").length
    const rejected = results.filter((r) => r.reviewStatus === "rejected").length
    const edited = results.filter((r) => r.reviewStatus === "edited").length

    return (
        <div className="space-y-4">
            {/* Summary Strip */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 font-mono">
                <StatTile label="Total Conclusions" value={results.length} hint="AI-generated root cause analyses" />
                <StatTile label="Pending Review" value={pending} tone={pending > 0 ? "critical" : "ok"} hint="awaiting human verdict" />
                <StatTile label="Approved" value={approved} tone="ok" hint="confirmed accurate" />
                <StatTile label="Rejected" value={rejected} tone="critical" hint="false positive or inaccurate" />
                <StatTile label="Edited" value={edited} hint="corrected by reviewer" />
            </div>

            {/* Filter Bar */}
            <div className="flex items-center gap-2 border-b border-border/40 pb-3">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mr-2">Filter</span>
                {(["all", "pending", "approved", "rejected", "edited"] as const).map((f) => {
                    const count = f === "all" ? results.length : results.filter((r) => r.reviewStatus === f).length
                    return (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={cn(
                                "px-2.5 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer",
                                filter === f
                                    ? "bg-primary/15 text-foreground font-medium"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                            )}
                        >
                            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                            <span className="ml-1 text-[10px] text-muted-foreground">{count}</span>
                        </button>
                    )
                })}
            </div>

            {/* Conclusion Cards — Single column for detailed readability */}
            {filtered.length === 0 ? (
                <Card className="border-dashed border-border/60">
                    <CardContent className="py-12 text-center text-sm text-muted-foreground">
                        {filter === "all"
                            ? "No AI conclusions generated yet. Run a diagnostic analysis first."
                            : `No conclusions with status "${filter}".`}
                    </CardContent>
                </Card>
            ) : (
                <div className="flex flex-col gap-4">
                    {filtered.map((r) => (
                        <AIConclusion
                            key={r.id}
                            result={r}
                            anomaly={anomalies.find((a) => a.id === r.anomalyId)}
                            onReviewed={onReviewed}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
function Reports({ overview }: { overview: Overview | null }) { return <SectionCard title="Diagnostic Report Registry" description="Audit-ready incident reports generated from verified telemetry"><div className="flex flex-col gap-3"><div className="flex items-center justify-between border-b border-border pb-3"><div><p className="text-sm font-medium">Warehouse Autonomous Navigation Incident Report</p><p className="font-mono text-[10px] text-muted-foreground">RPT-2026-071 · 3 root causes · 2 human audits</p></div><div className="flex gap-2"><Button variant="outline" size="sm"><DownloadIcon data-icon="inline-start" />JSON</Button><Button size="sm">Publish</Button></div></div><pre className="max-h-72 overflow-auto border border-border bg-muted/20 p-4 font-mono text-xs text-muted-foreground">{json({ generatedAt: "2026-07-31T09:00:00Z", anomalies: overview?.totals.anomalies ?? 0, recommendations: ["Isolate sensor VLAN", "Reserve controller CPU"] })}</pre></div></SectionCard> }
function Architecture() {
    const layers = [
        { step: "01", label: "Object Storage", detail: "ROSBag2 SQLite3 & Foxglove MCAP streams", proto: "file → ingest" },
        { step: "02", label: "FastAPI Telemetry Engine", detail: "Streaming parser → QoS indexer → Rule engine", proto: "REST" },
        { step: "03", label: "Specialized LLM Agents", detail: "Evidence-grounded root cause synthesis", proto: "inference" },
        { step: "04", label: "Human-in-the-Loop", detail: "Labeled feedback loop & continuous calibration", proto: "audit" },
    ]

    // Real FastAPI routes (all under /api/v1); the browser hits the same paths
    // via the Next.js proxy rewrite in next.config.mjs.
    const endpoints = [
        { method: "POST", path: "/api/v1/auth/login", desc: "JWT login" },
        { method: "GET", path: "/api/v1/datasets", desc: "List rosbag datasets" },
        { method: "POST", path: "/api/v1/datasets/upload", desc: "Upload .db3 / .mcap / .zip" },
        { method: "DELETE", path: "/api/v1/datasets/{id}", desc: "Delete a dataset" },
        { method: "POST", path: "/api/v1/analysis", desc: "Run diagnostics on a dataset" },
        { method: "GET", path: "/api/v1/analysis/{id}", desc: "Detections + AI conclusions" },
        { method: "GET", path: "/api/v1/analysis/{id}/health", desc: "Health summary for a run" },
        { method: "GET", path: "/api/v1/analysis/{id}/export/windows", desc: "Per-window NDJSON stream" },
        { method: "GET", path: "/api/v1/analysis/{id}/deep-dive", desc: "LLM root-cause deep dive" },
        { method: "GET", path: "/api/v1/analysis/thresholds", desc: "Read / update detection thresholds" },
        { method: "GET", path: "/api/v1/runs", desc: "Analysis runs + real LLM token/cost" },
        { method: "GET", path: "/api/v1/dashboard/overview", desc: "Fleet metrics & trends" },
        { method: "GET", path: "/api/v1/review", desc: "HITL review queue" },
        { method: "POST", path: "/api/v1/review/{id}/decision", desc: "Submit reviewer verdict" },
        { method: "GET", path: "/api/v1/review/stats", desc: "Agent accuracy from verdicts" },
        { method: "POST", path: "/api/v1/chat", desc: "LLM chat (OpenAI-compatible)" },
        { method: "GET", path: "/api/v1/llm/health", desc: "LLM provider reachability" },
    ]

    return (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            {/* Platform Architecture */}
            <SectionCard title="Platform Architecture & Dataflow" description="Operational boundary across capture, stream parsing, rule engine, LLM inference, and HITL verification">
                <div className="space-y-3">
                    {layers.map((layer, i) => (
                        <div key={layer.step} className="group flex items-start gap-3 rounded-md border border-border/60 bg-muted/10 p-3 hover:bg-muted/20 transition-colors">
                            <span className="font-mono text-[10px] font-bold text-muted-foreground/60 leading-5 shrink-0 w-5 text-right">{layer.step}</span>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-foreground">{layer.label}</p>
                                <p className="text-xs text-muted-foreground mt-0.5">{layer.detail}</p>
                            </div>
                            <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0">{layer.proto}</span>
                        </div>
                    ))}
                </div>

                {/* Protocol chain */}
                <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
                    <Badge variant="outline" className="text-[10px]">FastAPI /api/v1</Badge>
                    <ArrowRightIcon className="size-3 text-muted-foreground/40" />
                    <Badge variant="outline" className="text-[10px]">Next.js proxy rewrite</Badge>
                    <ArrowRightIcon className="size-3 text-muted-foreground/40" />
                    <Badge variant="outline" className="text-[10px]">Web Console (SWR + poll)</Badge>
                </div>
            </SectionCard>

            {/* API Contract Reference */}
            <SectionCard title="API Contract Reference" description="Primary RPC endpoints for Python core services">
                {/* Endpoint table */}
                <div className="space-y-0 divide-y divide-border/40">
                    {endpoints.map((ep) => (
                        <div key={ep.path} className="flex items-center gap-3 py-2 text-xs font-mono">
                            <span className={cn(
                                "shrink-0 w-10 text-[10px] font-semibold uppercase",
                                ep.method === "POST" ? "text-foreground" : ep.method === "WS" ? "text-muted-foreground" : "text-muted-foreground"
                            )}>{ep.method}</span>
                            <span className="flex-1 truncate text-foreground">{ep.path}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground/70 hidden sm:inline">{ep.desc}</span>
                        </div>
                    ))}
                </div>

                <Separator className="my-4" />

                {/* Live updates */}
                <div className="space-y-2">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Live Updates</span>
                    <p className="text-xs font-mono text-muted-foreground leading-relaxed">
                        No WebSocket or SSE on the backend. The console polls <span className="text-foreground">GET /api/v1/runs</span> every
                        5s for an in-flight analysis (stage / progress); other views refetch on navigation.
                    </p>
                </div>
            </SectionCard>
        </div>
    )
}

function AnalysisWorkspace({ activeRun, rosbag, anomalies, logs, selected, setSelected, lanes, playhead, setPlayhead, selectedResult, view, setView, topicFilter, setTopicFilter, timeRange, setTimeRange, thresholds, setThresholds, savingThresholds, setSavingThresholds, onReviewed, durationSec, startSec, topics, latencyWindows, runRootCause }: { activeRun: AnalysisRun | null; rosbag: Rosbag | null; anomalies: Anomaly[]; logs: LogEvent[]; selected: string | null; setSelected: (id: string) => void; lanes: Lane[]; playhead: number; setPlayhead: (time: number) => void; selectedResult?: AIResult; view: { from: number; to: number }; setView: (view: { from: number; to: number }) => void; topicFilter: string; setTopicFilter: (topic: string) => void; timeRange: string; setTimeRange: (range: string) => void; thresholds: Record<string, number>; setThresholds: (thresholds: Record<string, number>) => void; savingThresholds: boolean; setSavingThresholds: (saving: boolean) => void; onReviewed: (result: AIResult) => void; durationSec: number; startSec: number; topics: TopicStat[]; latencyWindows: LatencyWindow[]; runRootCause: RunRootCause | null }) {
    const duration = durationSec
    const [severities, setSeverities] = useState<Severity[]>([])
    const visibleLanes = topicFilter === "all" ? lanes : lanes.filter((lane) => lane.topic === topicFilter)
    const visibleAnomalies = timeRange === "all" ? anomalies : anomalies.filter((item) => relativeSpan(item).start <= Number(timeRange))

    const sortedAnomalies = [...visibleAnomalies].sort((a, b) => (a.tRelSec ?? a.tSec ?? 0) - (b.tRelSec ?? b.tSec ?? 0))

    const jumpToPrevAnomaly = () => {
        if (sortedAnomalies.length === 0) return
        const prev = [...sortedAnomalies].reverse().find(a => (a.tRelSec ?? a.tSec ?? 0) < playhead - 0.1) ?? sortedAnomalies[sortedAnomalies.length - 1]
        if (prev) {
            const t = prev.tRelSec ?? prev.tSec ?? 0
            setSelected(prev.id)
            setPlayhead(t)
            toast.info(`Jumped to ${prev.title} @ ${t.toFixed(1)}s`)
        }
    }

    const jumpToNextAnomaly = () => {
        if (sortedAnomalies.length === 0) return
        const next = sortedAnomalies.find(a => (a.tRelSec ?? a.tSec ?? 0) > playhead + 0.1) ?? sortedAnomalies[0]
        if (next) {
            const t = next.tRelSec ?? next.tSec ?? 0
            setSelected(next.id)
            setPlayhead(t)
            toast.info(`Jumped to ${next.title} @ ${t.toFixed(1)}s`)
        }
    }

    const zoomPreset = (seconds: number | "all") => {
        if (seconds === "all") {
            setView({ from: startSec, to: duration })
        } else {
            const half = seconds / 2
            const from = Math.max(0, playhead - half)
            const to = Math.min(duration, from + seconds)
            setView({ from, to })
        }
    }

    const saveThresholds = async () => {
        setSavingThresholds(true)
        try {
            const payload = await post<{ thresholds: Record<string, number> }>('/api/v1/analysis/thresholds', { thresholds })
            setThresholds(payload.thresholds)
            toast.success('Threshold configuration updated')
        } catch {
            toast.error('Failed to save threshold configuration')
        } finally {
            setSavingThresholds(false)
        }
    }
    return (
        <div className="flex min-h-[680px] flex-col gap-3">
            <AnalysisControlBar
                activeRun={activeRun}
                lanes={lanes}
                topicFilter={topicFilter}
                setTopicFilter={setTopicFilter}
                timeRange={timeRange}
                setTimeRange={setTimeRange}
                onTimeRangeChange={(value) => {
                    setTimeRange(value)
                    setView({ from: startSec, to: value === "all" ? duration : startSec + Number(value) })
                }}
                thresholds={thresholds}
                setThresholds={setThresholds}
                savingThresholds={savingThresholds}
                saveThresholds={saveThresholds}
            />
            {runRootCause && (
                <Card className="border-l-2 border-l-primary/60 shadow-xs">
                    <CardContent className="space-y-1.5 py-3">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                                Run Root Cause
                            </span>
                            <SeverityBadge severity={runRootCause.severity} />
                            <span className="font-mono text-[10px] text-muted-foreground">
                                onset t={clock(runRootCause.tSec, false)}
                            </span>
                        </div>
                        <p className="text-sm font-medium text-foreground">{runRootCause.rootCause}</p>
                        {runRootCause.explanation && runRootCause.explanation !== runRootCause.rootCause && (
                            <p className="text-xs text-muted-foreground leading-relaxed">{runRootCause.explanation}</p>
                        )}
                        {runRootCause.suggestedFix.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                                {runRootCause.suggestedFix.map((fix, i) => (
                                    <li key={i} className="flex gap-1.5 text-xs text-muted-foreground">
                                        <span className="text-primary">→</span>
                                        <span>{fix}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            )}
            <AnalysisHealthPanel
                activeRunId={activeRun?.id ?? null}
                rosbag={rosbag}
                anomalies={anomalies}
                logs={logs}
                topics={topics}
                latencyWindows={latencyWindows}
                onSelectAnomaly={(id) => {
                    setSelected(id)
                    const target = anomalies.find((a) => a.id === id)
                    if (target) {
                        const targetTime = target.tRelSec !== undefined ? target.tRelSec : target.tSec
                        setPlayhead(targetTime)
                        toast.info(`Focused on ${target.title} at ${targetTime.toFixed(1)}s`)
                        document.getElementById("message-timeline-section")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
                    }
                }}
                onSeek={(t) => {
                    setPlayhead(t)
                    document.getElementById("message-timeline-section")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
                }}
            />
            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] items-start">
                <Card className="min-h-0 h-[680px] lg:h-[720px] max-h-[calc(100vh-140px)] sticky top-4 flex flex-col overflow-hidden shadow-xs">
                    <AnomalyList
                        anomalies={visibleAnomalies}
                        selectedId={selected}
                        severities={severities}
                        onSeveritiesChange={setSeverities}
                        onSelect={(anomaly) => {
                            setSelected(anomaly.id)
                            setPlayhead(anomaly.tRelSec ?? anomaly.tSec ?? 0)
                        }}
                    />
                </Card>
                <div className="flex min-w-0 flex-col gap-4">
                    <Card id="message-timeline-section" className="min-w-0 overflow-hidden flex flex-col shadow-xs">
                        <CardHeader className="flex-row items-center justify-between border-b border-border py-2 px-4 gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <CardTitle className="text-sm font-semibold truncate">Timeline & Anomaly Heatmap</CardTitle>
                                <span className="font-mono text-[10px] text-muted-foreground hidden 2xl:inline truncate">
                                    {activeRun?.rosbagName ?? ""}
                                </span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {/* Previous / Next Fault Seek Controls */}
                                <div className="flex items-center gap-0.5 rounded border border-border/80 bg-muted/40 p-0.5 font-mono text-[10px]">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-1.5 text-[10px] cursor-pointer hover:text-primary"
                                        title="Jump to previous fault"
                                        onClick={jumpToPrevAnomaly}
                                    >
                                        <SkipBackIcon className="size-3 mr-0.5" /> Prev
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-1.5 text-[10px] cursor-pointer hover:text-primary"
                                        title="Jump to next fault"
                                        onClick={jumpToNextAnomaly}
                                    >
                                        Next <SkipForwardIcon className="size-3 ml-0.5" />
                                    </Button>
                                </div>

                                {/* Zoom Presets */}
                                <div className="flex items-center gap-0.5 rounded border border-border/80 bg-muted/40 p-0.5 font-mono text-[10px]">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-1.5 text-[10px] cursor-pointer"
                                        onClick={() => zoomPreset(5)}
                                    >
                                        5s
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-1.5 text-[10px] cursor-pointer"
                                        onClick={() => zoomPreset(30)}
                                    >
                                        30s
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-1.5 text-[10px] cursor-pointer"
                                        onClick={() => zoomPreset("all")}
                                    >
                                        Fit
                                    </Button>
                                </div>

                                {/* High-legibility Digital Clock Badge */}
                                <Badge variant="outline" data-testid="timeline-playhead" className="font-mono text-xs font-bold px-2 py-0.5 bg-background border-primary/40 text-primary">
                                    {clock(playhead)}
                                </Badge>
                            </div>
                        </CardHeader>
                        <CardContent className="p-0 pt-2 min-h-[360px]">
                            <TimelineCanvas durationSec={duration} lanes={visibleLanes} anomalies={visibleAnomalies} playhead={playhead} view={view} selectedAnomalyId={selected} onScrub={setPlayhead} onViewChange={setView} onSelectAnomaly={setSelected} />
                        </CardContent>
                    </Card>
                    <div className="min-w-0">
                        {selectedResult ? (
                            <AIConclusion result={selectedResult} anomaly={visibleAnomalies.find((item) => item.id === selectedResult.anomalyId)} onSeek={setPlayhead} onReviewed={onReviewed} />
                        ) : (
                            <Card className="border-dashed border-border/80 shadow-xs">
                                <CardContent className="p-5 text-sm text-muted-foreground flex items-center justify-center min-h-[100px]">
                                    Select an anomaly from the left panel to inspect AI Root Cause Analysis & remediation.
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

const pct = (value: number | null) => (value === null ? "--" : `${Math.round(value * 100)}%`)

/**
 * Agent accuracy measured from human verdicts — the payoff of the HITL loop.
 */
function ReportsEnhanced({ activeRun }: { activeRun: AnalysisRun | null }) {
    const [stats, setStats] = useState<ReviewStats | null>(null)
    const [failed, setFailed] = useState(false)

    const load = (isCancelled: () => boolean = () => false) => {
        fetcher<ReviewStats>("/api/review/stats")
            .then((payload) => { if (!isCancelled()) { setStats(payload); setFailed(false) } })
            .catch(() => { if (!isCancelled()) setFailed(true) })
    }
    useEffect(() => {
        let cancelled = false
        load(() => cancelled)
        return () => { cancelled = true }
    }, [])

    if (failed) return <SectionCard title="Agent Diagnostic Precision" description="Human-in-the-Loop audit verdict aggregates"><p className="py-8 text-sm text-muted-foreground">Unable to load review statistics.</p></SectionCard>
    if (!stats) return <SectionCard title="Agent Diagnostic Precision" description="Human-in-the-Loop audit verdict aggregates"><p className="py-8 text-sm text-muted-foreground">Loading audit statistics...</p></SectionCard>

    const copyJson = () => {
        navigator.clipboard?.writeText(json(stats))
        toast.success("Copied precision report JSON")
    }

    return <>
        {/* Summary KPIs — No icons, calm left-border accents */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 font-mono">
            <StatTile label="Agent Precision" value={pct(stats.accuracy)} tone={stats.accuracy !== null && stats.accuracy < 0.7 ? "critical" : "ok"} hint={`${stats.approved} approved out of ${stats.reviewed} audited`} />
            <StatTile label="Audited Verdicts" value={stats.reviewed} hint={`${stats.pending} pending in queue`} />
            <StatTile label="Rejected Diagnoses" value={stats.rejected} tone="critical" hint="false positive / inaccurate RCA" />
            <StatTile label="Edited by Engineers" value={stats.edited} hint="root causes corrected by reviewers" />
        </div>

        {/* Per-Run Table */}
        <SectionCard
            title="Per-Run Diagnostic Precision"
            description="Human expert verdicts recorded for each diagnostic run"
            actions={
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => load()} className="cursor-pointer"><RefreshCwIcon data-icon="inline-start" />Refresh</Button>
                    <Button variant="outline" size="sm" onClick={copyJson} className="cursor-pointer"><DownloadIcon data-icon="inline-start" />JSON</Button>
                </div>
            }
        >
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm font-mono">
                    <thead className="border-b border-border/60 text-[10px] uppercase text-muted-foreground font-medium tracking-wider">
                        <tr>
                            <th className="pb-2">Diagnostic Run</th>
                            <th className="pb-2 text-right">Detections</th>
                            <th className="pb-2 text-right">Audited</th>
                            <th className="pb-2 text-right">Approved</th>
                            <th className="pb-2 text-right">Rejected</th>
                            <th className="pb-2 text-right">Edited</th>
                            <th className="pb-2 text-right">Precision</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                        {stats.runs.map((run) => (
                            <tr key={run.runId} className={cn("hover:bg-muted/10 transition-colors", activeRun?.id === run.runId ? "bg-accent/20" : undefined)}>
                                <td className="py-3">
                                    <span className="text-xs font-sans font-semibold text-foreground">{run.rosbagName}</span>
                                    <div className="font-mono text-[10px] text-muted-foreground/70">{run.runId}</div>
                                </td>
                                <td className="py-3 text-right font-mono text-xs text-foreground">{run.total}</td>
                                <td className="py-3 text-right font-mono text-xs text-foreground">{run.reviewed}</td>
                                <td className="py-3 text-right font-mono text-xs text-foreground">{run.approved}</td>
                                <td className="py-3 text-right font-mono text-xs text-foreground">{run.rejected}</td>
                                <td className="py-3 text-right font-mono text-xs text-foreground">{run.edited}</td>
                                <td className="py-3 text-right font-mono text-xs font-semibold text-foreground">{pct(run.accuracy)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {stats.runs.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground font-sans">No diagnostic runs recorded yet.</p> : null}
            </div>
            <p className="mt-4 border-t border-border/40 pt-3 text-[11px] text-muted-foreground font-sans leading-relaxed">
                Precision = approved / audited. Recall is not reported: requires ground-truth labels for anomalies the agent never raised, which the audit queue cannot observe.
            </p>
        </SectionCard>
    </>
}

