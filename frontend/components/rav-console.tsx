"use client"

import { useEffect, useState } from "react"
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
import type { AIResult, Anomaly, AnalysisRun, LogEvent, ReviewStats, Rosbag, Severity, TopicStat, LlmRequest } from "@/lib/types"

import { AnalysisHealthPanel } from "@/components/health/analysis-health-panel"
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
 */
function buildTimelineLanes(rows: WindowSummaryRow[], windowSec: number): { lanes: Lane[]; durationSec: number; startSec: number } {
    if (rows.length === 0) return { lanes: [], durationSec: 0, startSec: 0 }
    const startOf = (row: WindowSummaryRow) => Date.parse(row.window_start) / 1000
    const durationSec = Math.max(...rows.map((row) => startOf(row) + windowSec))
    const startSec = Math.min(...rows.map(startOf))

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
                hz: Number(hz.toFixed(2)),
                expectedHz: Number(expectedHz.toFixed(2)),
                dropRate: expectedHz > 0 ? Math.max(0, Number((1 - hz / expectedHz).toFixed(4))) : 0,
            }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
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
    const [logs, setLogs] = useState<LogEvent[]>([])
    const [metrics, setMetrics] = useState<any>(null)
    const [requests, setRequests] = useState<LlmRequest[]>([])
    const [selected, setSelected] = useState<string | null>(null)
    const [playhead, setPlayhead] = useState(42.8)
    const [thresholds, setThresholds] = useState<Record<string, number>>({})
    const [savingThresholds, setSavingThresholds] = useState(false)
    const [timelineView, setTimelineView] = useState({ from: 0, to: 120 })
    const [timelineLanes, setTimelineLanes] = useState<Lane[]>([])
    const [timelineDuration, setTimelineDuration] = useState(0)
    const [timelineStart, setTimelineStart] = useState(0)
    const [topicStats, setTopicStats] = useState<TopicStat[]>([])
    const [topicFilter, setTopicFilter] = useState("all")
    const [timeRange, setTimeRange] = useState("all")

    const refreshBags = () => {
        fetcher<{ items: Rosbag[] }>("/api/rosbags").then((x) => {
            setBags(x.items)
        }).catch(() => {
            toast.error("Unable to load ROSBag datasets")
        })
    }

    useEffect(() => { fetcher<Overview>("/api/overview").then(setOverview).catch(() => toast.error("Unable to load fleet overview")); refreshBags() }, [])
    useEffect(() => {
        const run = overview?.recentRuns?.find((x) => x.status === "succeeded") ?? overview?.recentRuns?.[0]
        if (!run || activeRun?.id === run.id) return
        setActiveRun(run)
        Promise.all([
            fetcher<{ anomalies: Anomaly[]; aiResults: AIResult[] }>(`/api/runs/${run.id}`),
            fetcher<{ logs: LogEvent[] }>(`/api/runs/${run.id}/logs`).catch(() => ({ logs: [] as LogEvent[] })),
          ]).then(([detail, logsData]) => { setAnomalies(detail.anomalies); setAiResults(detail.aiResults); setLogs(logsData.logs); setSelected(detail.anomalies[0]?.id ?? null) })
    }, [overview, activeRun])

    useEffect(() => {
        if (section !== "analysis" || !activeRun) return
        let cancelled = false
        fetchWindowSummaries(activeRun.id, TIMELINE_WINDOW_SEC).then((rows) => {
            if (cancelled) return
            const { lanes, durationSec, startSec } = buildTimelineLanes(rows, TIMELINE_WINDOW_SEC)
            setTimelineLanes(lanes)
            setTopicStats(buildTopicStats(rows))
            setTimelineDuration(durationSec)
            setTimelineStart(startSec)
            setTimelineView({ from: startSec, to: durationSec })
        }).catch(() => {
            if (cancelled) return
            setTimelineLanes([])
            setTopicStats([])
            setTimelineDuration(0)
            setTimelineStart(0)
        })
        return () => { cancelled = true }
    }, [section, activeRun])

    useEffect(() => { if (section === "llm") { fetcher<any>("/api/llm/metrics?windowMin=60").then(setMetrics); fetcher<{ items: LlmRequest[] }>('/api/llm/requests').then((x) => setRequests(x.items)) } }, [section])
    useEffect(() => { if (section === "analysis") { fetcher<{ thresholds: Record<string, number> }>('/api/v1/analysis/thresholds').then((payload) => setThresholds(payload.thresholds)).catch(() => toast.error('Unable to load threshold configuration')) } }, [section])

    const selectedAnomaly = anomalies.find((a) => a.id === selected) ?? anomalies[0]
    const selectedResult = aiResults.find((r) => r.anomalyId === selectedAnomaly?.id) ?? aiResults[0]
    const navigate = (href: string) => router.push(href)
    const handleReviewed = (updated: AIResult) => setAiResults((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    const title = ({ dashboard: "Fleet Overview", datasets: "ROSBag Registry", analysis: "Diagnostics Workspace", review: "Human Review", reports: "Diagnostic Reports", llm: "LLM Observability", architecture: "System Architecture" } as Record<string, string>)[section] ?? "RAV-13"

    return <main className="min-h-[calc(100vh-3rem)] bg-background p-4 md:p-6"><div className="mx-auto flex max-w-[1800px] flex-col gap-5">
        <PageHeader title={title} description={section === "analysis" ? `${activeRun?.rosbagName ?? "Select a run"} · Synchronized Diagnostics Surface` : "ROS2 Doctor + LLM Agent Telemetry Platform"} actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => window.location.reload()} className="cursor-pointer"><RefreshCwIcon data-icon="inline-start" />Refresh</Button>{section === "datasets" ? <Button size="sm" onClick={refreshBags} className="cursor-pointer"><UploadIcon data-icon="inline-start" />Refresh List</Button> : null}</div>} />
        {section === "dashboard" && <DashboardOverview overview={overview} navigate={navigate} />}
        {/* Dataset Registry Surface (Actions: "Diagnose Selected", "Upload ROSBag", "Filter by bag name") */}
        {section === "datasets" && <CaptureRegistry bags={bags} onRefresh={refreshBags} navigate={navigate} />}
        {section === "analysis" && <AnalysisWorkspace activeRun={activeRun} rosbag={bags.find(b => b.id === activeRun?.rosbagId) ?? null} anomalies={anomalies} logs={logs} selected={selected} setSelected={setSelected} lanes={timelineLanes} playhead={playhead} setPlayhead={setPlayhead} selectedResult={selectedResult} view={timelineView} setView={setTimelineView} topicFilter={topicFilter} setTopicFilter={setTopicFilter} timeRange={timeRange} setTimeRange={setTimeRange} thresholds={thresholds} setThresholds={setThresholds} savingThresholds={savingThresholds} setSavingThresholds={setSavingThresholds} onReviewed={handleReviewed} durationSec={timelineDuration} startSec={timelineStart} topics={topicStats} />}
        {section === "review" && <Review results={aiResults} anomalies={anomalies} onReviewed={handleReviewed} />}
        {section === "reports" && <ReportsEnhanced activeRun={activeRun} />}
        {section === "llm" && <LlmMonitoring metrics={metrics} requests={requests} />}
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
function LlmMonitoring({ metrics, requests }: { metrics: any; requests: LlmRequest[] }) {
    const [tab, setTab] = useState("metrics")
    const [selectedRequest, setSelectedRequest] = useState<LlmRequest | null>(null)
    const a = metrics?.aggregates
    const errors = requests.filter((request) => request.status !== "ok")
    return <>
        {/* KPI Strip — Calm monochrome with subtle left-border accents */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 font-mono">
            <StatTile label="Inference Rate" value={a?.tokensPerSec ?? "--"} unit="tok/s" tone="primary" />
            <StatTile label="Requests / sec" value={a?.rps ?? "--"} unit="req/s" />
            <StatTile label="P95 Latency" value={a?.p95 ?? "--"} unit="ms" />
            <StatTile label="Queue Depth" value={a?.queueLen ?? "--"} unit="req" />
            <StatTile label="P99 Latency" value={a?.p99 ?? "--"} unit="ms" />
        </div>

        <Tabs value={tab} onValueChange={setTab} className="w-full">
            <TabsList>
                <TabsTrigger value="metrics">System Metrics</TabsTrigger>
                <TabsTrigger value="requests">Request Logs</TabsTrigger>
                <TabsTrigger value="errors">Errors <span className="ml-1 font-mono text-[10px] text-muted-foreground">{errors.length}</span></TabsTrigger>
            </TabsList>

            <TabsContent value="metrics">
                <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
                    {/* Inference Performance */}
                    <SectionCard title="Inference Performance" description="Real-time execution telemetry">
                        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 font-mono">
                            {([["p50", a?.p50], ["p95", a?.p95], ["p99", a?.p99], ["req/sec", a?.rps]] as [string, any][]).map(([label, value]) => (
                                <div key={label} className="border-l border-border/60 pl-3">
                                    <p className="font-mono text-[10px] uppercase text-muted-foreground tracking-wider">{label}</p>
                                    <p className="mt-1 font-mono text-xl font-semibold text-foreground tabular-nums">{value ?? "--"}</p>
                                </div>
                            ))}
                        </div>
                        {/* Throughput spark bars */}
                        <div className="mt-5 h-24 border-t border-border/40 pt-2">
                            <div className="flex h-full items-end gap-px px-1">
                                {(metrics?.points ?? []).slice(-40).map((point: any, index: number) => (
                                    <div
                                        key={index}
                                        className="flex-1 bg-primary/40 hover:bg-primary/60 transition-colors rounded-t-xs"
                                        style={{ height: `${Math.max(8, Math.min(100, point.tokensPerSec / 20))}%` }}
                                    />
                                ))}
                            </div>
                        </div>
                    </SectionCard>

                    {/* Provider Configuration */}
                    <SectionCard title="Provider Configuration" description="Active LLM engine settings">
                        <div className="space-y-0 divide-y divide-border/40">
                            <MetaRow label="provider" value={metrics?.provider?.name ?? "--"} />
                            <MetaRow label="model" value={metrics?.provider?.model ?? "--"} />
                            <MetaRow label="max context window" value={metrics?.provider?.maxModelLen ?? "--"} />
                            <MetaRow label="avg throughput" value={a?.tokensPerSec ? `${a.tokensPerSec} tok/s` : "--"} />
                        </div>
                    </SectionCard>
                </div>
            </TabsContent>

            <TabsContent value="requests">
                <RequestLog requests={requests} onSelect={setSelectedRequest} />
            </TabsContent>
            <TabsContent value="errors">
                <RequestLog requests={errors} onSelect={setSelectedRequest} empty="No LLM errors during this window." />
            </TabsContent>
        </Tabs>

        {/* Trace Detail Panel */}
        {selectedRequest ? (
            <Card className="border-border/80 bg-card/60">
                <CardHeader className="flex-row items-center justify-between py-3">
                    <CardTitle className="text-sm">Trace {selectedRequest.id}</CardTitle>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedRequest(null)} className="cursor-pointer">Close</Button>
                </CardHeader>
                <CardContent>
                    <div className="grid gap-2 sm:grid-cols-5 font-mono">
                        {([["Prompt", selectedRequest.promptTokens], ["Tokenizer", selectedRequest.tokenizeMs], ["Prefill", selectedRequest.prefillMs], ["Decode", selectedRequest.decodeMs], ["Completion", selectedRequest.completionTokens]] as [string, any][]).map(([label, value]) => (
                            <div key={label} className="border border-border/60 rounded-md bg-muted/10 p-3">
                                <p className="font-mono text-[10px] uppercase text-muted-foreground tracking-wider">{label}</p>
                                <p className="mt-1 font-mono text-sm font-semibold text-foreground tabular-nums">{value}{label === "Prompt" || label === "Completion" ? " tok" : " ms"}</p>
                            </div>
                        ))}
                    </div>
                    <p className="mt-3 font-mono text-xs text-muted-foreground leading-relaxed">{selectedRequest.promptPreview}</p>
                </CardContent>
            </Card>
        ) : null}
    </>
}

function RequestLog({ requests, onSelect, empty = "No request traces available." }: { requests: LlmRequest[]; onSelect: (request: LlmRequest) => void; empty?: string }) { return <SectionCard title="Inference Trace Log" description="Inspect request pipeline breakdown: Prompt → Tokenizer → Prefill → Decode → Completion"><div className="flex flex-col divide-y divide-border font-mono">{requests.slice(0, 40).map((request) => <button key={request.id} onClick={() => onSelect(request)} className="py-2 text-left hover:bg-accent/40 cursor-pointer"><div className="flex items-center gap-2"><StatusLabel status={request.status} /><span className="min-w-0 flex-1 truncate font-mono text-[11px]">{request.promptPreview}</span><span className="font-mono text-[10px] text-muted-foreground">{ms(request.latencyMs)}</span></div><div className="mt-1 flex gap-2 pl-16 font-mono text-[10px] text-muted-foreground"><span>queue {request.queueMs}ms</span><span>prefill {request.prefillMs}ms</span><span>decode {request.decodeMs}ms</span></div></button>)}{requests.length === 0 ? <p className="py-8 text-sm text-muted-foreground font-sans">{empty}</p> : null}</div></SectionCard> }
function Architecture() {
    const layers = [
        { step: "01", label: "Object Storage", detail: "ROSBag2 SQLite3 & Foxglove MCAP streams", proto: "file → ingest" },
        { step: "02", label: "FastAPI Telemetry Engine", detail: "Streaming parser → QoS indexer → Rule engine", proto: "REST / WS" },
        { step: "03", label: "Specialized LLM Agents", detail: "Evidence-grounded root cause synthesis", proto: "inference" },
        { step: "04", label: "Human-in-the-Loop", detail: "Labeled feedback loop & continuous calibration", proto: "audit" },
    ]

    const endpoints = [
        { method: "POST", path: "/api/rosbags", desc: "Upload capture artifact" },
        { method: "POST", path: "/api/rosbags/:id/parse", desc: "Parse bag structure" },
        { method: "POST", path: "/api/runs", desc: "Queue diagnostic analysis" },
        { method: "GET", path: "/api/runs/:id/timeline", desc: "Fetch timeline lanes" },
        { method: "GET", path: "/api/runs/:id/ai", desc: "Retrieve AI conclusions" },
        { method: "POST", path: "/api/feedback", desc: "Submit HITL verdict" },
        { method: "GET", path: "/api/reports", desc: "List diagnostic reports" },
        { method: "GET", path: "/api/llm/metrics", desc: "LLM performance metrics" },
        { method: "WS", path: "/api/stream", desc: "Real-time event stream" },
    ]

    const wsChannels = [
        { channel: "job.progress", desc: "Analysis stage updates" },
        { channel: "log", desc: "Structured ROS2 diagnostic events" },
        { channel: "simulation.sync", desc: "Temporal playhead & anomaly selection synchronization" },
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
                    <Badge variant="outline" className="text-[10px]">REST</Badge>
                    <ArrowRightIcon className="size-3 text-muted-foreground/40" />
                    <Badge variant="outline" className="text-[10px]">WebSocket /stream</Badge>
                    <ArrowRightIcon className="size-3 text-muted-foreground/40" />
                    <Badge variant="outline" className="text-[10px]">Next.js Web Console</Badge>
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

                {/* WebSocket channels */}
                <div className="space-y-2">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">WebSocket Channels</span>
                    <div className="space-y-1.5">
                        {wsChannels.map((ch) => (
                            <div key={ch.channel} className="flex items-baseline gap-2 text-xs font-mono">
                                <span className="font-semibold text-foreground">{ch.channel}</span>
                                <span className="text-muted-foreground">{ch.desc}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </SectionCard>
        </div>
    )
}

function AnalysisWorkspace({ activeRun, rosbag, anomalies, logs, selected, setSelected, lanes, playhead, setPlayhead, selectedResult, view, setView, topicFilter, setTopicFilter, timeRange, setTimeRange, thresholds, setThresholds, savingThresholds, setSavingThresholds, onReviewed, durationSec, startSec, topics }: { activeRun: AnalysisRun | null; rosbag: Rosbag | null; anomalies: Anomaly[]; logs: LogEvent[]; selected: string | null; setSelected: (id: string) => void; lanes: Lane[]; playhead: number; setPlayhead: (time: number) => void; selectedResult?: AIResult; view: { from: number; to: number }; setView: (view: { from: number; to: number }) => void; topicFilter: string; setTopicFilter: (topic: string) => void; timeRange: string; setTimeRange: (range: string) => void; thresholds: Record<string, number>; setThresholds: (thresholds: Record<string, number>) => void; savingThresholds: boolean; setSavingThresholds: (saving: boolean) => void; onReviewed: (result: AIResult) => void; durationSec: number; startSec: number; topics: TopicStat[] }) {
    const duration = durationSec
    const [severities, setSeverities] = useState<Severity[]>([])
    const visibleLanes = topicFilter === "all" ? lanes : lanes.filter((lane) => lane.topic === topicFilter)
    const visibleAnomalies = timeRange === "all" ? anomalies : anomalies.filter((item) => item.tSec <= startSec + Number(timeRange))

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
            <AnalysisHealthPanel
                activeRunId={activeRun?.id ?? null}
                rosbag={rosbag}
                anomalies={anomalies}
                logs={logs}
                topics={topics}
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

    const load = () => {
        fetcher<ReviewStats>("/api/review/stats")
            .then((payload) => { setStats(payload); setFailed(false) })
            .catch(() => setFailed(true))
    }
    useEffect(load, [])

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
                    <Button variant="outline" size="sm" onClick={load} className="cursor-pointer"><RefreshCwIcon data-icon="inline-start" />Refresh</Button>
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

