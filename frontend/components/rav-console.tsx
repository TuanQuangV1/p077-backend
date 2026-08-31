"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
    ActivityIcon, ArrowRightIcon, BotIcon, CircleAlertIcon,
    CpuIcon, DatabaseIcon, DownloadIcon, FileTextIcon, GaugeIcon,
    PlayIcon, RefreshCwIcon, SearchIcon, ServerIcon, ShieldCheckIcon, Trash2Icon, UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

import { AIConclusion } from "@/components/ai-conclusion"
import { AnomalyList } from "@/components/analysis/anomaly-list"
import { TimelineCanvas, type Lane } from "@/components/analysis/timeline-canvas"
import { MetaRow, PageHeader, SectionCard, SeverityBadge, StatTile, StatusLabel } from "@/components/telemetry"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { bytes, clock, compact, del, fetchWindowSummaries, fetcher, ms, post, uploadRosbag, type WindowSummaryRow } from "@/lib/api"
import type { AIResult, Anomaly, AnalysisRun, LogEvent, ReviewStats, Rosbag, TopicStat, LlmRequest } from "@/lib/types"

import { AnalysisHealthPanel } from "@/components/health/analysis-health-panel"
import { HealthBadge } from "@/components/health/health-gauge"
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
        {section === "dashboard" && <DashboardEnhanced overview={overview} navigate={navigate} />}
        {section === "datasets" && <DatasetRegistry bags={bags} onRefresh={refreshBags} navigate={navigate} />}
        {section === "analysis" && <AnalysisWorkspace activeRun={activeRun} rosbag={bags.find(b => b.id === activeRun?.rosbagId) ?? null} anomalies={anomalies} logs={logs} selected={selected} setSelected={setSelected} lanes={timelineLanes} playhead={playhead} setPlayhead={setPlayhead} selectedResult={selectedResult} view={timelineView} setView={setTimelineView} topicFilter={topicFilter} setTopicFilter={setTopicFilter} timeRange={timeRange} setTimeRange={setTimeRange} thresholds={thresholds} setThresholds={setThresholds} savingThresholds={savingThresholds} setSavingThresholds={setSavingThresholds} onReviewed={handleReviewed} durationSec={timelineDuration} startSec={timelineStart} topics={topicStats} />}
        {section === "review" && <Review results={aiResults} anomalies={anomalies} onReviewed={handleReviewed} />}
        {section === "reports" && <ReportsEnhanced activeRun={activeRun} />}
        {section === "llm" && <LlmMonitoring metrics={metrics} requests={requests} />}
        {section === "architecture" && <Architecture />}
    </div></main>
}

function Review({ results, anomalies, onReviewed }: { results: AIResult[]; anomalies: Anomaly[]; onReviewed: (result: AIResult) => void }) { return <div className="grid gap-4 lg:grid-cols-2">{results.map((r) => <AIConclusion key={r.id} result={r} anomaly={anomalies.find((a) => a.id === r.anomalyId)} onReviewed={onReviewed} compact />)}</div> }
function Reports({ overview }: { overview: Overview | null }) { return <SectionCard title="Diagnostic Report Registry" description="Audit-ready incident reports generated from verified telemetry"><div className="flex flex-col gap-3"><div className="flex items-center justify-between border-b border-border pb-3"><div><p className="text-sm font-medium">Warehouse Autonomous Navigation Incident Report</p><p className="font-mono text-[10px] text-muted-foreground">RPT-2026-071 · 3 root causes · 2 human audits</p></div><div className="flex gap-2"><Button variant="outline" size="sm"><DownloadIcon data-icon="inline-start" />JSON</Button><Button size="sm">Publish</Button></div></div><pre className="max-h-72 overflow-auto border border-border bg-muted/20 p-4 font-mono text-xs text-muted-foreground">{json({ generatedAt: "2026-07-31T09:00:00Z", anomalies: overview?.totals.anomalies ?? 0, recommendations: ["Isolate sensor VLAN", "Reserve controller CPU"] })}</pre></div></SectionCard> }
function LlmMonitoring({ metrics, requests }: { metrics: any; requests: LlmRequest[] }) {
    const [tab, setTab] = useState("metrics")
    const [selectedRequest, setSelectedRequest] = useState<LlmRequest | null>(null)
    const a = metrics?.aggregates
    const errors = requests.filter((request) => request.status !== "ok")
    return <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 font-mono"><StatTile label="Inference Rate" value={a?.tokensPerSec ?? "--"} unit="tok/s" tone="primary" icon={<GaugeIcon className="size-4" />} /><StatTile label="Requests / sec" value={a?.rps ?? "--"} unit="req/s" /><StatTile label="P95 Latency" value={a?.p95 ?? "--"} unit="ms" /><StatTile label="Queue Depth" value={a?.queueLen ?? "--"} unit="req" /><StatTile label="P99 Latency" value={a?.p99 ?? "--"} unit="ms" /></div>
        <Tabs value={tab} onValueChange={setTab} className="w-full"><TabsList><TabsTrigger value="metrics">System Metrics</TabsTrigger><TabsTrigger value="requests">Request Logs</TabsTrigger><TabsTrigger value="errors">Errors <span className="ml-1 font-mono text-[10px]">{errors.length}</span></TabsTrigger></TabsList>
            <TabsContent value="metrics"><div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]"><SectionCard title="Inference Performance" description="Real-time execution telemetry"><div className="grid grid-cols-2 gap-4 sm:grid-cols-4 font-mono">{[["p50", a?.p50], ["p95", a?.p95], ["p99", a?.p99], ["req/sec", a?.rps]].map(([label, value]) => <div key={label as string} className="border-l-2 border-primary/50 pl-3"><p className="font-mono text-[10px] uppercase text-muted-foreground">{label}</p><p className="mt-1 font-mono text-xl">{value ?? "--"}</p></div>)}</div><div className="mt-5 h-24 border-b border-border"><div className="flex h-full items-end gap-1 px-1">{(metrics?.points ?? []).slice(-40).map((point: any, index: number) => <div key={index} className="flex-1 bg-primary/60" style={{ height: `${Math.max(8, Math.min(100, point.tokensPerSec / 20))}%` }} />)}</div></div></SectionCard><SectionCard title="Provider Configuration" description="Active LLM engine settings"><MetaRow label="provider" value={metrics?.provider?.name ?? "--"} /><MetaRow label="model" value={metrics?.provider?.model ?? "--"} /><MetaRow label="max context window" value={metrics?.provider?.maxModelLen ?? "--"} /><MetaRow label="avg throughput" value={a?.tokensPerSec ? `${a.tokensPerSec} tok/s` : "--"} /></SectionCard></div></TabsContent>
            <TabsContent value="requests"><RequestLog requests={requests} onSelect={setSelectedRequest} /></TabsContent>
            <TabsContent value="errors"><RequestLog requests={errors} onSelect={setSelectedRequest} empty="No LLM errors during this window." /></TabsContent>
        </Tabs>{selectedRequest ? <Card className="border-primary/40"><CardHeader className="flex-row items-center justify-between py-3"><CardTitle className="text-sm">Trace {selectedRequest.id}</CardTitle><Button variant="ghost" size="sm" onClick={() => setSelectedRequest(null)}>Close</Button></CardHeader><CardContent><div className="grid gap-2 sm:grid-cols-5 font-mono">{
                      [["Prompt", selectedRequest.promptTokens], ["Tokenizer", selectedRequest.tokenizeMs], ["Prefill", selectedRequest.prefillMs], ["Decode", selectedRequest.decodeMs], ["Completion", selectedRequest.completionTokens]].map(([label, value]) => <div key={label as string} className="border border-border p-3"><p className="font-mono text-[10px] uppercase text-muted-foreground">{label}</p><p className="mt-1 font-mono text-sm">{value}{label === "Prompt" || label === "Completion" ? " tok" : " ms"}</p></div>)}</div><p className="mt-3 font-mono text-xs text-muted-foreground">{selectedRequest.promptPreview}</p></CardContent></Card> : null}
    </>
}

function RequestLog({ requests, onSelect, empty = "No request traces available." }: { requests: LlmRequest[]; onSelect: (request: LlmRequest) => void; empty?: string }) { return <SectionCard title="Inference Trace Log" description="Inspect request pipeline breakdown: Prompt → Tokenizer → Prefill → Decode → Completion"><div className="flex flex-col divide-y divide-border font-mono">{requests.slice(0, 40).map((request) => <button key={request.id} onClick={() => onSelect(request)} className="py-2 text-left hover:bg-accent/40 cursor-pointer"><div className="flex items-center gap-2"><StatusLabel status={request.status} /><span className="min-w-0 flex-1 truncate font-mono text-[11px]">{request.promptPreview}</span><span className="font-mono text-[10px] text-muted-foreground">{ms(request.latencyMs)}</span></div><div className="mt-1 flex gap-2 pl-16 font-mono text-[10px] text-muted-foreground"><span>queue {request.queueMs}ms</span><span>prefill {request.prefillMs}ms</span><span>decode {request.decodeMs}ms</span></div></button>)}{requests.length === 0 ? <p className="py-8 text-sm text-muted-foreground font-sans">{empty}</p> : null}</div></SectionCard> }
function Architecture() { return <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]"><SectionCard title="Platform Architecture & Dataflow" description="Operational boundary across capture, stream parsing, rule engine, LLM inference, and HITL verification"><div className="grid gap-3 sm:grid-cols-2">{[[DatabaseIcon, "Object Storage", "ROSBag2 SQLite3 & Foxglove MCAP streams"], [ServerIcon, "FastAPI Telemetry Engine", "Streaming parser → QoS indexer → Rule engine"], [BotIcon, "Specialized LLM Agents", "Evidence-grounded root cause synthesis"], [ShieldCheckIcon, "Human-in-the-Loop", "Labeled feedback loop & continuous calibration"]].map(([Icon, label, detail]) => <div key={label as string} className="flex items-start gap-3 border border-border p-3"><div className="grid size-8 shrink-0 place-items-center bg-primary/10 text-primary"><Icon className="size-4" /></div><div><p className="text-sm font-medium">{label as string}</p><p className="text-xs text-muted-foreground">{detail as string}</p></div></div>)}</div><div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground"><Badge variant="outline">REST</Badge><ArrowRightIcon className="size-3" /><Badge variant="outline">WebSocket /stream</Badge><ArrowRightIcon className="size-3" /><Badge variant="outline">Next.js Web Console</Badge></div></SectionCard><SectionCard title="API Contract Reference" description="Primary RPC endpoints for Python core services"><pre className="overflow-auto font-mono text-xs leading-6 text-muted-foreground">{`POST /api/rosbags\nPOST /api/rosbags/:id/parse\nPOST /api/runs\nGET  /api/runs/:id/timeline\nGET  /api/runs/:id/ai\nPOST /api/feedback\nGET  /api/reports\nGET  /api/llm/metrics\nWS   /api/stream`}</pre><Separator className="my-4" /><div className="flex flex-col gap-2 text-xs font-mono"><p><span className="text-primary font-semibold">job.progress</span> Analysis stage updates</p><p><span className="text-primary font-semibold">log</span> Structured ROS2 diagnostic events</p><p><span className="text-primary font-semibold">simulation.sync</span> Temporal playhead & anomaly selection synchronization</p></div></SectionCard></div> }

function DashboardEnhanced({ overview, navigate }: { overview: Overview | null; navigate: (href: string) => void }) {
    const totals = overview?.totals ?? {}
    const [healthScore, setHealthScore] = useState<{ score: number; status: string } | null>(null)

    useEffect(() => {
        const run = overview?.recentRuns?.find((x) => x.status === "succeeded") ?? overview?.recentRuns?.[0]
        if (!run) return
        fetcher<HealthSummary>(`/api/runs/${run.id}/health`)
            .then((h) => setHealthScore({ score: h.health_score, status: h.status }))
            .catch(() => {})
    }, [overview])

    return <>
        <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 flex-1"><StatTile label="ROSBags Analyzed" value={totals.analyzed ?? "--"} hint={`${totals.rosbags ?? 0} registered · ${totals.hoursOfData ?? 0}h capture`} icon={<DatabaseIcon className="size-4" />} /><StatTile label="Anomalous Run Ratio" value={totals.runsWithIssuesPct ? `${totals.runsWithIssuesPct}%` : "--"} tone="critical" hint={`${totals.anomalies ?? 0} anomalies detected`} icon={<CircleAlertIcon className="size-4" />} /><StatTile label="Mean Time to Diagnose" value={totals.meanTimeToDiagnoseSec ?? "--"} unit="s" hint="from ingestion to AI RCA" icon={<ActivityIcon className="size-4" />} /><StatTile label="AI Inference Cost" value={totals.inferenceCostUsd ? `$${totals.inferenceCostUsd}` : "--"} hint={`${compact(totals.tokens ?? 0)} tokens consumed`} icon={<CpuIcon className="size-4" />} /></div>
            {healthScore && <HealthBadge score={healthScore.score} status={healthScore.status as "green" | "yellow" | "red"} />}
        </div>
        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]"><SectionCard title="14-Day Fleet Telemetry Trend" description="Ingestion throughput, anomaly volume, and P95 diagnostic latency"><div className="flex h-44 items-end gap-1 border-b border-border px-1">{(overview?.trend ?? []).map((point) => <div key={point.date} className="group relative flex h-full flex-1 items-end gap-0.5"><div className="w-1/2 bg-primary/70" style={{ height: `${Math.max(8, (point.bags / 20) * 100)}%` }} /><div className="w-1/2 bg-critical/70" style={{ height: `${Math.max(5, (point.anomalies / 24) * 100)}%` }} /><span className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-1.5 py-1 font-mono text-[10px] group-hover:block">{point.date} · {point.p95Ms}ms</span></div>)}</div><div className="mt-2 flex gap-4 font-mono text-[10px] text-muted-foreground"><span><i className="mr-1 inline-block size-2 bg-primary/70" />ROSBags</span><span><i className="mr-1 inline-block size-2 bg-critical/70" />Anomalies</span><span className="ml-auto">P95 Latency / Cost Tracked</span></div></SectionCard><SectionCard title="Recent Diagnostic Runs" description="Latest ROSBag anomaly triage runs" actions={<Button variant="ghost" size="sm" onClick={() => navigate("/analysis")} className="cursor-pointer">Open Workspace <ArrowRightIcon data-icon="inline-end" /></Button>}><div className="divide-y divide-border">{overview?.recentRuns.map((run) => <button key={run.id} onClick={() => navigate("/analysis")} className="flex w-full items-center gap-3 py-3 text-left hover:bg-accent/30 cursor-pointer"><StatusLabel status={run.status} /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{run.rosbagName}</span><span className="font-mono text-xs text-muted-foreground">{run.anomalyCount} faults</span></button>)}</div></SectionCard></div>
    </>
}

function DatasetRegistry({ bags, onRefresh, navigate }: { bags: Rosbag[]; onRefresh: () => void; navigate: (href: string) => void }) {
    const [query, setQuery] = useState("")
    const [busy, setBusy] = useState<string | null>(null)
    const [uploading, setUploading] = useState(false)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [fileInputKey, setFileInputKey] = useState(0)
    const filtered = bags.filter((bag) => `${bag.name} ${bag.site} ${bag.robotType}`.toLowerCase().includes(query.toLowerCase()))

    const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
    const toggleAll = () => setSelected((prev) => (filtered.length > 0 && filtered.every((bag) => prev.has(bag.id)) ? new Set() : new Set(filtered.map((bag) => bag.id))))
    const allSelected = filtered.length > 0 && filtered.every((bag) => selected.has(bag.id))

    const upload = async (file: File | undefined) => {
        if (!file) return
        setUploading(true)
        try {
            await uploadRosbag(file)
            toast.success("ROSBag uploaded successfully", { description: file.name })
            onRefresh()
        } catch (err) {
            const _err = err as Error;
            toast.error("Upload failed: " + (_err?.message ?? "unsupported file format"))
        } finally {
            setUploading(false)
            setFileInputKey(k => k + 1)
        }
    }

    const remove = async (bag: Rosbag) => {
        if (!window.confirm(`Are you sure you want to delete ${bag.name}?`)) return
        setBusy(bag.id)
        try {
            await del(`/api/rosbags/${bag.id}`)
            toast.success("Dataset deleted")
            setSelected((prev) => { const next = new Set(prev); next.delete(bag.id); return next })
            onRefresh()
        } catch {
            toast.error("Unable to delete dataset")
        } finally {
            setBusy(null)
        }
    }

    const analyze = async (bag: Rosbag) => { setBusy(bag.id); try { const result = await post<{ run: AnalysisRun }>("/api/runs", { rosbag_id: bag.id }); toast.success("Diagnostics completed", { description: result.run.id }); window.location.assign("/analysis") } catch { toast.error("Unable to run diagnostics") } finally { setBusy(null) } }
    const analyzeSelected = async () => {
        const ids = filtered.filter((bag) => selected.has(bag.id)).map((bag) => bag.id)
        if (ids.length === 0) return
        setBusy("batch")
        try {
            const results = await Promise.all(ids.map((id) => post<{ run: AnalysisRun }>("/api/runs", { rosbag_id: id })))
            toast.success(`${results.length} diagnostic run${results.length > 1 ? "s" : ""} queued`)
            window.location.assign("/analysis")
        } catch {
            toast.error("Unable to queue diagnostics")
        } finally {
            setBusy(null)
        }
    }

    return <SectionCard title="ROSBag Capture Registry" description="Upload, manage, and trigger diagnostics across recorded robot datasets" actions={<div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={uploading || selected.size === 0} onClick={analyzeSelected} className="cursor-pointer"><PlayIcon data-icon="inline-start" />Diagnose Selected{selected.size ? ` (${selected.size})` : ""}</Button><Button size="sm" disabled={uploading} onClick={() => document.getElementById('file-upload-input')?.click()} className="cursor-pointer"><UploadIcon data-icon="inline-start" />{uploading ? "Ingesting..." : "Upload ROSBag"}</Button><input key={fileInputKey} id="file-upload-input" type="file" accept=".db3,.mcap,.bag,.zip" className="hidden" onChange={(e) => upload(e.target.files?.[0])} /></div>}><div className="mb-4 flex max-w-xl items-center gap-2"><SearchIcon className="size-4 text-muted-foreground" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by bag name, robot, or site..." /></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border font-mono text-[10px] uppercase text-muted-foreground"><tr><th className="pb-2"><Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" /></th><th className="pb-2">ROSBag Artifact</th><th className="pb-2">Platform / Facility</th><th className="pb-2">Payload / Duration</th><th className="pb-2">Status</th><th className="pb-2 text-right">Actions</th></tr></thead><tbody className="divide-y divide-border">{filtered.map((bag) => <tr key={bag.id} className={selected.has(bag.id) ? "bg-accent/30" : undefined}><td className="py-3"><Checkbox checked={selected.has(bag.id)} onCheckedChange={() => toggle(bag.id)} aria-label={`Select ${bag.name}`} /></td><td className="py-3 font-mono text-xs font-semibold">{bag.name}<div className="text-[10px] text-muted-foreground font-sans">{bag.messageCount.toLocaleString()} messages</div></td><td className="py-3 text-xs">{bag.robotType}<div className="text-muted-foreground">{bag.site}</div></td><td className="py-3 font-mono text-xs">{bytes(bag.sizeBytes)}<div className="text-muted-foreground font-sans">{clock(bag.durationSec, false)}</div></td><td className="py-3"><div className="flex flex-col gap-0.5"><StatusLabel status={bag.analysisStatus ?? "not_analyzed"} />{bag.analysisStatus === "succeeded" ? (<span className="font-mono text-[10px] text-muted-foreground flex items-center gap-1">{bag.analysisAnomalyCount ?? 0} faults{bag.worstSeverity ? (<SeverityBadge severity={bag.worstSeverity as any} className="ml-1" />) : null}</span>) : null}</div></td><td className="py-3 text-right"><div className="flex justify-end gap-1"><Button size="sm" variant="ghost" disabled={busy === bag.id} onClick={() => analyze(bag)} className="cursor-pointer">Diagnose</Button><Button size="sm" variant="ghost" disabled={busy === bag.id} onClick={() => remove(bag)} className="cursor-pointer text-muted-foreground hover:text-rose-400"><Trash2Icon data-icon="inline-start" />Delete</Button></div></td></tr>)}</tbody></table></div></SectionCard>
}

function AnalysisWorkspace({ activeRun, rosbag, anomalies, logs, selected, setSelected, lanes, playhead, setPlayhead, selectedResult, view, setView, topicFilter, setTopicFilter, timeRange, setTimeRange, thresholds, setThresholds, savingThresholds, setSavingThresholds, onReviewed, durationSec, startSec, topics }: { activeRun: AnalysisRun | null; rosbag: Rosbag | null; anomalies: Anomaly[]; logs: LogEvent[]; selected: string | null; setSelected: (id: string) => void; lanes: Lane[]; playhead: number; setPlayhead: (time: number) => void; selectedResult?: AIResult; view: { from: number; to: number }; setView: (view: { from: number; to: number }) => void; topicFilter: string; setTopicFilter: (topic: string) => void; timeRange: string; setTimeRange: (range: string) => void; thresholds: Record<string, number>; setThresholds: (thresholds: Record<string, number>) => void; savingThresholds: boolean; setSavingThresholds: (saving: boolean) => void; onReviewed: (result: AIResult) => void; durationSec: number; startSec: number; topics: TopicStat[] }) {
    const duration = durationSec
    const visibleLanes = topicFilter === "all" ? lanes : lanes.filter((lane) => lane.topic === topicFilter)
    const visibleAnomalies = timeRange === "all" ? anomalies : anomalies.filter((item) => item.tSec <= startSec + Number(timeRange))
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
    return <div className="flex min-h-[680px] flex-col gap-3"><div className="flex flex-wrap items-center gap-2 border border-border bg-card p-2"><select value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)} className="h-8 border border-input bg-background px-2 font-mono text-xs cursor-pointer"><option value="all">All Topics</option>{lanes.map((lane) => <option key={lane.topic} value={lane.topic}>{lane.topic}</option>)}</select><select value={timeRange} onChange={(e) => { const value = e.target.value; setTimeRange(value); setView({ from: startSec, to: value === "all" ? duration : startSec + Number(value) }) }} className="h-8 border border-input bg-background px-2 font-mono text-xs cursor-pointer"><option value="all">Full ROSBag Run</option><option value="30">First 30 Seconds</option><option value="60">First 60 Seconds</option></select><span className="ml-auto font-mono text-[10px] text-muted-foreground">{activeRun?.stage ?? "done"} · {activeRun?.progress ?? 0}% · {lanes.length} lanes</span></div><Card data-testid="thresholds-panel"><CardContent className="flex flex-wrap items-end gap-3 p-3"><label className="grid gap-1 text-xs text-muted-foreground">Frequency Gap Threshold (sec)<Input data-testid="threshold-frequency-gap" type="number" min="0" step="0.01" value={thresholds.frequency_gap_min_threshold_sec ?? ""} onChange={(event) => setThresholds({ ...thresholds, frequency_gap_min_threshold_sec: Number(event.target.value) })} className="h-8 w-44 font-mono text-xs" /></label><label className="grid gap-1 text-xs text-muted-foreground">Silent Node Timeout (sec)<Input type="number" min="0" step="0.1" value={thresholds.silent_node_min_span_sec ?? ""} onChange={(event) => setThresholds({ ...thresholds, silent_node_min_span_sec: Number(event.target.value) })} className="h-8 w-44 font-mono text-xs" /></label><Button data-testid="save-thresholds" size="sm" variant="outline" disabled={savingThresholds || Object.keys(thresholds).length === 0} onClick={saveThresholds} className="cursor-pointer">{savingThresholds ? "Saving..." : "Save Thresholds"}</Button></CardContent></Card><AnalysisHealthPanel activeRunId={activeRun?.id ?? null} rosbag={rosbag} anomalies={anomalies} logs={logs} topics={topics} onSelectAnomaly={(id) => { setSelected(id); setPlayhead(anomalies.find(a => a.id === id)?.tSec ?? 0) }} onSeek={setPlayhead} /><div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[230px_minmax(0,1fr)_380px]"><Card className="min-h-0 overflow-hidden"><CardHeader className="border-b border-border py-3"><CardTitle className="text-sm">Detected Faults <span className="font-mono text-[10px] text-muted-foreground">({visibleAnomalies.length})</span></CardTitle></CardHeader><AnomalyList anomalies={visibleAnomalies} selectedId={selected} severities={[]} onSeveritiesChange={() => { }} onSelect={(anomaly) => { setSelected(anomaly.id); setPlayhead(anomaly.tSec) }} /></Card><Card className="min-w-0 overflow-hidden"><CardHeader className="flex-row items-center justify-between border-b border-border py-3"><div><CardTitle className="text-sm font-semibold">Message Timeline & Anomaly Heatmap</CardTitle><p className="font-mono text-[10px] text-muted-foreground">{activeRun?.rosbagName ?? "Loading run"} · drag to scrub · shift+drag to pan</p></div><Badge variant="outline" data-testid="timeline-playhead" className="font-mono text-[10px]">{clock(playhead)}</Badge></CardHeader><CardContent className="p-0 pt-3"><TimelineCanvas durationSec={duration} lanes={visibleLanes} anomalies={visibleAnomalies} playhead={playhead} view={view} selectedAnomalyId={selected} onScrub={setPlayhead} onViewChange={setView} onSelectAnomaly={setSelected} /></CardContent></Card><div className="min-h-0 overflow-auto space-y-3">{selectedResult ? <AIConclusion result={selectedResult} anomaly={visibleAnomalies.find((item) => item.id === selectedResult.anomalyId)} onSeek={setPlayhead} onReviewed={onReviewed} /> : <Card><CardContent className="p-5 text-sm text-muted-foreground">Select an anomaly to inspect AI Root Cause Analysis.</CardContent></Card>}</div></div></div>
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 font-mono">
            <StatTile label="Agent Precision" value={pct(stats.accuracy)} tone={stats.accuracy !== null && stats.accuracy < 0.7 ? "critical" : "primary"} hint={`${stats.approved} approved out of ${stats.reviewed} audited`} icon={<ShieldCheckIcon className="size-4" />} />
            <StatTile label="Audited Verdicts" value={stats.reviewed} hint={`${stats.pending} pending in queue`} icon={<FileTextIcon className="size-4" />} />
            <StatTile label="Rejected Diagnoses" value={stats.rejected} tone="critical" hint="false positive / inaccurate RCA" icon={<CircleAlertIcon className="size-4" />} />
            <StatTile label="Edited by Engineers" value={stats.edited} hint="root causes corrected by reviewers" icon={<ActivityIcon className="size-4" />} />
        </div>
        <SectionCard
            title="Per-Run Diagnostic Precision"
            description="Human expert verdicts recorded for each diagnostic run"
            actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={load} className="cursor-pointer"><RefreshCwIcon data-icon="inline-start" />Refresh</Button><Button variant="outline" size="sm" onClick={copyJson} className="cursor-pointer"><DownloadIcon data-icon="inline-start" />JSON</Button></div>}
        >
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm font-mono">
                    <thead className="border-b border-border text-[10px] uppercase text-muted-foreground font-medium">
                        <tr><th className="pb-2">Diagnostic Run</th><th className="pb-2 text-right">Detections</th><th className="pb-2 text-right">Audited</th><th className="pb-2 text-right">Approved</th><th className="pb-2 text-right">Rejected</th><th className="pb-2 text-right">Edited</th><th className="pb-2 text-right">Precision</th></tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {stats.runs.map((run) => (
                            <tr key={run.runId} className={activeRun?.id === run.runId ? "bg-accent/30" : undefined}>
                                <td className="py-3"><span className="text-xs font-sans font-semibold text-foreground">{run.rosbagName}</span><div className="font-mono text-[10px] text-muted-foreground">{run.runId}</div></td>
                                <td className="py-3 text-right font-mono text-xs">{run.total}</td>
                                <td className="py-3 text-right font-mono text-xs">{run.reviewed}</td>
                                <td className="py-3 text-right font-mono text-xs text-ok">{run.approved}</td>
                                <td className="py-3 text-right font-mono text-xs text-critical">{run.rejected}</td>
                                <td className="py-3 text-right font-mono text-xs">{run.edited}</td>
                                <td className="py-3 text-right font-mono text-xs font-semibold">{pct(run.accuracy)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {stats.runs.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground font-sans">No diagnostic runs recorded yet.</p> : null}
            </div>
            <p className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground font-sans">
                Precision = approved / audited. Recall is not reported: requires ground-truth labels for anomalies the agent never raised, which the audit queue cannot observe.
            </p>
        </SectionCard>
    </>
}
