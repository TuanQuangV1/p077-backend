"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
    ActivityIcon, ArrowRightIcon, BotIcon, CircleAlertIcon,
    CpuIcon, DatabaseIcon, DownloadIcon, FileTextIcon, GaugeIcon,
    HelpCircleIcon, MinusIcon, PlayIcon, PlusIcon, RefreshCwIcon, RotateCcwIcon, SearchIcon, ServerIcon, ShieldCheckIcon, SparklesIcon, Trash2Icon, UploadIcon, ZoomInIcon, ZoomOutIcon,
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
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { bytes, clock, compact, del, fetchWindowSummaries, fetcher, ms, post, uploadRosbag, type WindowSummaryRow } from "@/lib/api"
import type { AIResult, Anomaly, AnalysisRun, LogEvent, ReviewStats, Rosbag, Severity, TopicStat, VllmRequest } from "@/lib/types"
import { cn } from "@/lib/utils"

import { AnalysisHealthPanel } from "@/components/health/analysis-health-panel"
import { VLLMObservability } from "@/components/vllm/vllm-observability"

type Overview = { totals: Record<string, number>; topIssues: { label: string; count: number }[]; severity: { severity: string; count: number }[]; trend: { date: string; bags: number; anomalies: number; p95Ms: number; costUsd: number }[]; recentRuns: AnalysisRun[] }

const json = (value: unknown) => JSON.stringify(value, null, 2)

const TIMELINE_WINDOW_SEC = 5
const TIMELINE_BUCKETS = 240

/**
 * Folds the backend's per-(topic, window) summary rows into canvas lanes.
 *
 * Bag timestamps are absolute seconds (a bag may start at t=350s), and the
 * canvas maps buckets over 0..durationSec, so durationSec is derived from the
 * last window rather than assumed — anomaly markers carry the same absolute
 * tSec and must line up with the density bars.
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
 *
 * The bag's own `expected_hz` is absent (rosbag2 does not record it), so the
 * nominal rate is the topic's best sustained window. The detector itself uses
 * median message cadence when no explicit expected rate is available; the UI
 * window summary does not include raw timestamps, so this remains an estimate
 * keeping the table consistent with the detections it sits next to.
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
    const section = rawSection === "vllm-monitoring" ? "vllm" : rawSection
    const [overview, setOverview] = useState<Overview | null>(null)
    const [bags, setBags] = useState<Rosbag[]>([])
    const [activeRun, setActiveRun] = useState<AnalysisRun | null>(null)
    const [anomalies, setAnomalies] = useState<Anomaly[]>([])
    const [aiResults, setAiResults] = useState<AIResult[]>([])
    const [logs, setLogs] = useState<LogEvent[]>([])
    const [metrics, setMetrics] = useState<any>(null)
    const [requests, setRequests] = useState<VllmRequest[]>([])
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
            toast.error("Cannot load datasets")
        })
    }

    useEffect(() => { fetcher<Overview>("/api/overview").then(setOverview).catch(() => toast.error("Overview unavailable")); refreshBags() }, [])
    useEffect(() => {
        const run = overview?.recentRuns?.[0]
        if (!run || activeRun?.id === run.id) return
        setActiveRun(run)
        Promise.all([
            fetcher<{ anomalies: Anomaly[]; aiResults: AIResult[] }>(`/api/runs/${run.id}`),
            fetcher<{ logs: LogEvent[] }>(`/api/runs/${run.id}/logs`).catch(() => ({ logs: [] as LogEvent[] })),
          ]).then(([detail, logsData]) => { setAnomalies(detail.anomalies); setAiResults(detail.aiResults); setLogs(logsData.logs); setSelected(detail.anomalies[0]?.id ?? null) })
    }, [overview, activeRun])
    // Fetched once per run: the backend re-reads the whole bag to build this,
    // so it must not be tied to view/filter changes (zoom would refetch ~1s).
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
            // Bags rarely start at t=0; open on the recorded span, not the empty lead-in.
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
    useEffect(() => { if (section === "vllm") { fetcher<any>("/api/vllm/metrics?windowMin=60").then(setMetrics); fetcher<{ items: VllmRequest[] }>('/api/vllm/requests').then((x) => setRequests(x.items)) } }, [section])
    useEffect(() => { if (section === "analysis") { fetcher<{ thresholds: Record<string, number> }>('/api/v1/analysis/thresholds').then((payload) => setThresholds(payload.thresholds)).catch(() => toast.error('Thresholds unavailable')) } }, [section])

    const loadVllm = async () => {
        try {
            const [m, r] = await Promise.all([
                fetcher<any>("/api/vllm/metrics?windowMin=60"),
                fetcher<{ items: VllmRequest[] }>('/api/vllm/requests'),
            ])
            setMetrics(m)
            setRequests(r.items)
            toast.success("Đã làm mới dữ liệu đo lường vLLM")
        } catch {
            toast.error("Không thể tải thông số vLLM")
        }
    }

    const selectedAnomaly = anomalies.find((a) => a.id === selected) ?? anomalies[0]
    const selectedResult = aiResults.find((r) => r.anomalyId === selectedAnomaly?.id) ?? aiResults[0]
    const navigate = (href: string) => router.push(href)
    const handleReviewed = (updated: AIResult) => setAiResults((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    const title = ({
        dashboard: "Tổng quan hạm đội",
        datasets: "Tập dữ liệu Rosbag",
        analysis: "Không gian phân tích",
        review: "Hàng đợi duyệt thủ công",
        reports: "Báo cáo chẩn đoán",
        vllm: "Giám sát vLLM",
        architecture: "Kiến trúc hệ thống",
    } as Record<string, string>)[section] ?? "RAV-13"

    const currentMeta = {
        dashboard: {
            badge: (
                <Badge variant="outline" className="border-border bg-muted/40 font-mono text-[11px] text-muted-foreground">
                    <span className="mr-1.5 size-1.5 rounded-full bg-ok inline-block" />
                    Trực tiếp /ws
                </Badge>
            ),
            description: "Tiếp nhận dữ liệu đo xa ROS 2 và chẩn đoán sự cố bất thường từ Rosbag",
        },
        datasets: {
            badge: <Badge variant="outline" className="font-mono text-[11px]">{bags.length} tập dữ liệu</Badge>,
            description: "Danh mục tệp dữ liệu cảm biến Rosbag2 SQLite (.db3) và Foxglove MCAP (.mcap)",
        },
        analysis: {
            badge: activeRun ? (
                <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary font-mono text-[11px]">
                    {activeRun.rosbagName}
                </Badge>
            ) : undefined,
            description: activeRun
                ? `${activeRun.anomalyCount} bất thường phát hiện · dòng thời gian đồng bộ & phân tích nguyên nhân gốc`
                : "Không gian làm việc chẩn đoán đồng bộ",
        },
        review: {
            badge: <Badge variant="outline" className="font-mono text-[11px]">Hàng đợi HITL</Badge>,
            description: "Hàng đợi chuyên gia đánh giá và phê duyệt kết luận chẩn đoán AI cùng biện pháp xử lý",
        },
        reports: {
            badge: <Badge variant="outline" className="font-mono text-[11px]">Sổ cái báo cáo</Badge>,
            description: "Sổ cái báo cáo sự cố và khuyến nghị kỹ thuật có thể trích xuất",
        },
        vllm: {
            badge: <Badge variant="outline" className="font-mono text-[11px] text-ok border-ok/30 bg-ok/10">Động cơ vLLM</Badge>,
            description: "Đo lường phần cứng GPU, mức tiêu thụ bộ nhớ VRAM và tốc độ giải mã Token",
        },
        architecture: {
            badge: <Badge variant="outline" className="font-mono text-[11px]">Đặc tả</Badge>,
            description: "Ranh giới hệ thống, quy trình nạp dữ liệu và đặc tả hợp đồng API",
        },
    }[section] ?? {
        badge: null,
        description: "Tiếp nhận dữ liệu đo xa ROS 2 và chẩn đoán sự cố bất thường từ Rosbag",
    }

    return <main className="min-h-[calc(100vh-3rem)] bg-background p-4 md:p-6"><div className="mx-auto flex max-w-[1800px] flex-col gap-5">
        <PageHeader
            title={title}
            badge={currentMeta.badge}
            description={currentMeta.description}
            actions={
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                        <RefreshCwIcon data-icon="inline-start" />Làm mới
                    </Button>
                    {section === "datasets" ? (
                        <Button size="sm" onClick={refreshBags}>
                            <UploadIcon data-icon="inline-start" />Làm mới danh sách
                        </Button>
                    ) : null}
                </div>
            }
        />
        {section === "dashboard" && <DashboardOverview overview={overview} navigate={navigate} />}
        {section === "datasets" && <CaptureRegistry bags={bags} onRefresh={refreshBags} />}


        {section === "analysis" && <AnalysisWorkspace activeRun={activeRun} rosbag={bags.find(b => b.id === activeRun?.rosbagId) ?? null} anomalies={anomalies} logs={logs} selected={selected} setSelected={setSelected} lanes={timelineLanes} playhead={playhead} setPlayhead={setPlayhead} selectedResult={selectedResult} view={timelineView} setView={setTimelineView} topicFilter={topicFilter} setTopicFilter={setTopicFilter} timeRange={timeRange} setTimeRange={setTimeRange} thresholds={thresholds} setThresholds={setThresholds} savingThresholds={savingThresholds} setSavingThresholds={setSavingThresholds} onReviewed={handleReviewed} durationSec={timelineDuration} startSec={timelineStart} topics={topicStats} />}
        {section === "review" && <Review results={aiResults} anomalies={anomalies} onReviewed={handleReviewed} />}
        {section === "reports" && <ReportsEnhanced activeRun={activeRun} />}
        {section === "vllm" && <VLLMObservability metrics={metrics} requests={requests} onRefresh={loadVllm} />}
        {section === "architecture" && <Architecture />}
    </div></main>
}

function Review({ results, anomalies, onReviewed }: { results: AIResult[]; anomalies: Anomaly[]; onReviewed: (result: AIResult) => void }) { return <div className="grid gap-4 lg:grid-cols-2">{results.map((r) => <AIConclusion key={r.id} result={r} anomaly={anomalies.find((a) => a.id === r.anomalyId)} onReviewed={onReviewed} compact />)}</div> }
function Reports({ overview }: { overview: Overview | null }) { return <SectionCard title="Report ledger" description="Auditable outputs generated from reviewed diagnosis"><div className="flex flex-col gap-3"><div className="flex items-center justify-between border-b border-border pb-3"><div><p className="text-sm font-medium">Warehouse navigation incident review</p><p className="font-mono text-[10px] text-muted-foreground">RPT-2026-071 · 3 key issues · 2 approvals</p></div><div className="flex gap-2"><Button variant="outline" size="sm"><DownloadIcon data-icon="inline-start" />JSON</Button><Button size="sm">Publish</Button></div></div><pre className="max-h-72 overflow-auto border border-border bg-muted/20 p-4 font-mono text-xs text-muted-foreground">{json({ generatedAt: "2026-07-31T09:00:00Z", anomalies: overview?.totals.anomalies ?? 0, recommendations: ["Isolate sensor VLAN", "Reserve controller CPU"] })}</pre></div></SectionCard> }
function Architecture() { return <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]"><SectionCard title="Pipeline topology" description="Production boundary between capture, diagnosis, review, and observability"><div className="grid gap-3 sm:grid-cols-2">{[[DatabaseIcon, "Object storage", "rosbag2 / MCAP files"], [ServerIcon, "FastAPI worker", "parse â†’ index â†’ detect"], [BotIcon, "Agent + VLLM", "evidence-grounded diagnosis"], [ShieldCheckIcon, "Human review", "labelled feedback loop"]].map(([Icon, label, detail]) => <div key={label as string} className="flex items-start gap-3 border border-border p-3"><div className="grid size-8 shrink-0 place-items-center bg-primary/10 text-primary"><Icon className="size-4" /></div><div><p className="text-sm font-medium">{label as string}</p><p className="text-xs text-muted-foreground">{detail as string}</p></div></div>)}</div><div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground"><Badge variant="outline">REST</Badge><ArrowRightIcon className="size-3" /><Badge variant="outline">WebSocket /stream</Badge><ArrowRightIcon className="size-3" /><Badge variant="outline">Next.js console</Badge></div></SectionCard><SectionCard title="Contract reference" description="Core API surfaces for the Python service"><pre className="overflow-auto font-mono text-xs leading-6 text-muted-foreground">{`POST /api/rosbags\nPOST /api/rosbags/:id/parse\nPOST /api/runs\nGET  /api/runs/:id/timeline\nGET  /api/runs/:id/ai\nPOST /api/feedback\nGET  /api/reports\nGET  /api/vllm/metrics\nWS   /api/stream`}</pre><Separator className="my-4" /><div className="flex flex-col gap-2 text-xs"><p><span className="text-primary">job.progress</span> parsing / analyzing stage updates</p><p><span className="text-primary">log</span> structured ROS2 log events</p><p><span className="text-primary">simulation.sync</span> timestamp and anomaly selection</p></div></SectionCard></div> }

import { DashboardOverview } from "@/components/dashboard/dashboard-overview"
import { CaptureRegistry } from "@/components/datasets/capture-registry"
import { AnalysisControlBar } from "@/components/analysis/analysis-control-bar"

function AnalysisWorkspace({ activeRun, rosbag, anomalies, logs, selected, setSelected, lanes, playhead, setPlayhead, selectedResult, view, setView, topicFilter, setTopicFilter, timeRange, setTimeRange, thresholds, setThresholds, savingThresholds, setSavingThresholds, onReviewed, durationSec, startSec, topics }: { activeRun: AnalysisRun | null; rosbag: Rosbag | null; anomalies: Anomaly[]; logs: LogEvent[]; selected: string | null; setSelected: (id: string) => void; lanes: Lane[]; playhead: number; setPlayhead: (time: number) => void; selectedResult?: AIResult; view: { from: number; to: number }; setView: (view: { from: number; to: number }) => void; topicFilter: string; setTopicFilter: (topic: string) => void; timeRange: string; setTimeRange: (range: string) => void; thresholds: Record<string, number>; setThresholds: (thresholds: Record<string, number>) => void; savingThresholds: boolean; setSavingThresholds: (saving: boolean) => void; onReviewed: (result: AIResult) => void; durationSec: number; startSec: number; topics: TopicStat[] }) {
    const duration = durationSec
    const [severities, setSeverities] = useState<Severity[]>([])
    const visibleLanes = topicFilter === "all" ? lanes : lanes.filter((lane) => lane.topic === topicFilter)
    const visibleAnomalies = timeRange === "all" ? anomalies : anomalies.filter((item) => item.tSec <= startSec + Number(timeRange))

    const zoomIn = () => {
        const span = Math.max(view.to - view.from, 0.1)
        const newSpan = Math.max(0.5, span * 0.6) // Thu hẹp khoảng thời gian (zoom in)
        const center = (playhead >= view.from && playhead <= view.to) ? playhead : (view.from + view.to) / 2
        let from = center - newSpan / 2
        let to = center + newSpan / 2
        if (from < 0) {
            from = 0
            to = Math.min(duration, newSpan)
        } else if (to > duration) {
            to = duration
            from = Math.max(0, duration - newSpan)
        }
        setView({ from, to })
    }

    const zoomOut = () => {
        const span = Math.max(view.to - view.from, 0.1)
        const newSpan = Math.min(duration, span * 1.6) // Mở rộng khoảng thời gian (zoom out)
        const center = (playhead >= view.from && playhead <= view.to) ? playhead : (view.from + view.to) / 2
        let from = center - newSpan / 2
        let to = center + newSpan / 2
        if (from < 0) {
            from = 0
            to = Math.min(duration, newSpan)
        } else if (to > duration) {
            to = duration
            from = Math.max(0, duration - newSpan)
        }
        setView({ from, to })
    }

    const saveThresholds = async () => {
        setSavingThresholds(true)
        try {
            const payload = await post<{ thresholds: Record<string, number> }>('/api/v1/analysis/thresholds', { thresholds })
            setThresholds(payload.thresholds)
            toast.success('Thresholds updated')
        } catch {
            toast.error('Unable to save thresholds')
        } finally {
            setSavingThresholds(false)
        }
    }
    return <div className="flex min-h-[680px] flex-col gap-4">
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
                const a = anomalies.find(item => item.id === id)
                if (a) setPlayhead(a.tSec)
            }}
            onSeek={setPlayhead}
        />

        {/* Bố cục Chữ L (L-Layout) chuẩn công nghiệp */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start" id="analysis-timeline-section">
            {/* Cột Trái (4/12 cols): Danh sách Bất thường phát hiện (Detections Stream) */}
            <Card className="lg:col-span-4 flex flex-col border border-border/80 bg-card/60 shadow-xs overflow-hidden h-full min-h-[580px] max-h-[660px]">
                <CardHeader className="border-b border-border/70 py-2.5 px-4 bg-muted/20 flex flex-row items-center justify-between shrink-0">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-foreground">
                        Bất thường phát hiện
                    </CardTitle>
                    <Badge variant="outline" className="font-mono text-[10px] font-bold">
                        {visibleAnomalies.length} sự kiện
                    </Badge>
                </CardHeader>
                <div className="flex-1 min-h-0">
                    <AnomalyList
                        anomalies={visibleAnomalies}
                        selectedId={selected}
                        severities={severities}
                        onSeveritiesChange={setSeverities}
                        onSelect={(anomaly) => {
                            setSelected(anomaly.id)
                            setPlayhead(anomaly.tSec)
                        }}
                    />
                </div>
            </Card>

            {/* Cột Phải (8/12 cols): 2 Tầng gồm Timeline ở trên & Chẩn đoán AI ở dưới */}
            <div className="lg:col-span-8 flex flex-col gap-4 min-w-0">
                {/* Tầng 1: Trục Thời Gian Viễn Trắc (Message Timeline) */}
                <Card className="border border-border/80 bg-card/60 shadow-xs overflow-hidden">
                    <CardHeader className="flex flex-row items-center justify-between border-b border-border/70 py-2.5 px-4 bg-muted/20 shrink-0">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-foreground truncate">
                                Trục Thời Gian Viễn Trắc
                            </CardTitle>
                            <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground hidden sm:inline-flex truncate max-w-[150px]">
                                {activeRun?.rosbagName ?? "Loading run"}
                            </Badge>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            {/* Cụm Nút Phóng to (+) và Thu nhỏ (-) Trục thời gian */}
                            <div className="flex items-center rounded-md border border-border/70 bg-background/60 p-0.5 shadow-2xs">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0 hover:bg-muted text-foreground cursor-pointer"
                                    onClick={zoomIn}
                                    title="Phóng to trục thời gian (Zoom In +)"
                                >
                                    <PlusIcon className="size-3.5" />
                                    <span className="sr-only">Zoom in</span>
                                </Button>
                                <div className="h-3.5 w-px bg-border/60 mx-0.5" />
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0 hover:bg-muted text-foreground cursor-pointer"
                                    onClick={zoomOut}
                                    title="Thu nhỏ trục thời gian (Zoom Out -)"
                                >
                                    <MinusIcon className="size-3.5" />
                                    <span className="sr-only">Zoom out</span>
                                </Button>
                            </div>

                            {/* Cụm Nút Preset Zoom Nhanh */}
                            <div className="flex items-center gap-1">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-[10px] font-mono cursor-pointer"
                                    onClick={() => setView({ from: Math.max(0, playhead - 5), to: Math.min(duration, playhead + 5) })}
                                    title="Phóng to 10s xung quanh vị trí hiện tại"
                                >
                                    ±5s
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-[10px] font-mono cursor-pointer"
                                    onClick={() => setView({ from: Math.max(0, playhead - 15), to: Math.min(duration, playhead + 15) })}
                                    title="Phóng to 30s xung quanh vị trí hiện tại"
                                >
                                    ±15s
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-[10px] font-mono cursor-pointer"
                                    onClick={() => setView({ from: 0, to: duration })}
                                    title="Xem toàn bộ thời gian rosbag"
                                >
                                    Toàn bộ
                                </Button>
                            </div>
                            <Badge variant="secondary" data-testid="timeline-playhead" className="font-mono text-xs font-bold px-2 py-0.5 border border-primary/30 text-primary">
                                ⏱ {clock(playhead)}
                            </Badge>
                        </div>
                    </CardHeader>
                    <CardContent className="p-0 pt-2 pb-2">
                        <TimelineCanvas
                            durationSec={duration}
                            lanes={visibleLanes}
                            anomalies={visibleAnomalies}
                            playhead={playhead}
                            view={view}
                            selectedAnomalyId={selected}
                            onScrub={setPlayhead}
                            onViewChange={setView}
                            onSelectAnomaly={(id) => {
                                setSelected(id)
                                const a = anomalies.find(item => item.id === id)
                                if (a) setPlayhead(a.tSec)
                            }}
                        />
                    </CardContent>
                </Card>

                {/* Tầng 2: Kết luận & Chẩn đoán AI (AI Conclusion & HITL Review) */}
                <div className="min-h-0 flex flex-col">
                    {selectedResult ? (
                        <AIConclusion
                            result={selectedResult}
                            anomaly={visibleAnomalies.find((item) => item.id === selectedResult.anomalyId)}
                            onSeek={setPlayhead}
                            onReviewed={onReviewed}
                        />
                    ) : (
                        <Card className="flex flex-1 flex-col items-center justify-center border border-dashed border-border/80 bg-card/40 p-8 text-center min-h-[340px]">
                            <div className="flex flex-col items-center gap-2.5 max-w-sm">
                                <div className="size-10 rounded-full bg-muted/40 border border-border flex items-center justify-center text-muted-foreground">
                                    <SparklesIcon className="size-5" />
                                </div>
                                <span className="text-sm font-semibold text-foreground">Chưa chọn sự cố bất thường</span>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    Hãy nhấp vào một sự cố ở danh sách bên trái hoặc trên biểu đồ Timeline để xem phân tích nguyên nhân gốc rễ và phê duyệt kết luận của AI.
                                </p>
                            </div>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    </div>
}

const pct = (value: number | null) => (value === null ? "--" : `${Math.round(value * 100)}%`)

/**
 * Agent accuracy measured from human verdicts — the payoff of the HITL loop.
 *
 * Accuracy is approved / reviewed. Recall is intentionally absent: it needs
 * ground-truth labels for anomalies the agent never raised, which the review
 * queue cannot observe.
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

    if (failed) return <SectionCard title="Độ chính xác AI" description="Tổng kết đánh giá kiểm thử từ chuyên gia"><p className="py-8 text-sm text-muted-foreground">Không có dữ liệu thống kê đánh giá.</p></SectionCard>
    if (!stats) return <SectionCard title="Độ chính xác AI" description="Tổng kết đánh giá kiểm thử từ chuyên gia"><p className="py-8 text-sm text-muted-foreground">Đang tải thống kê đánh giá...</p></SectionCard>

    const copyJson = () => {
        navigator.clipboard?.writeText(json(stats))
        toast.success("Đã sao chép báo cáo độ chính xác dạng JSON")
    }

    return <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Độ chính xác AI" value={pct(stats.accuracy)} tone={stats.accuracy !== null && stats.accuracy < 0.7 ? "critical" : "primary"} hint={`${stats.approved} đã phê duyệt / ${stats.reviewed} đã đánh giá`} icon={<ShieldCheckIcon className="size-4" />} />
            <StatTile label="Đã đánh giá" value={stats.reviewed} hint={`${stats.pending} kết luận đang chờ`} icon={<FileTextIcon className="size-4" />} />
            <StatTile label="Từ chối" value={stats.rejected} tone="critical" hint="kết luận AI không chính xác" icon={<CircleAlertIcon className="size-4" />} />
            <StatTile label="Đã hiệu chỉnh" value={stats.edited} hint="nguyên nhân gốc được sửa lại" icon={<ActivityIcon className="size-4" />} />
        </div>
        <SectionCard
            title="Độ chính xác theo từng lượt chạy"
            description="Kết luận đánh giá được chuyên gia ghi nhận theo từng lượt phân tích"
            actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={load}><RefreshCwIcon data-icon="inline-start" />Làm mới</Button><Button variant="outline" size="sm" onClick={copyJson}><DownloadIcon data-icon="inline-start" />JSON</Button></div>}
        >
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <thead className="border-b border-border font-mono text-[10px] uppercase text-muted-foreground">
                        <tr><th className="pb-2">Lượt chạy</th><th className="pb-2 text-right">Phát hiện</th><th className="pb-2 text-right">Đã đánh giá</th><th className="pb-2 text-right">Phê duyệt</th><th className="pb-2 text-right">Từ chối</th><th className="pb-2 text-right">Đã sửa</th><th className="pb-2 text-right">Độ chính xác</th></tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {stats.runs.map((run) => (
                            <tr key={run.runId} className={activeRun?.id === run.runId ? "bg-accent/30" : undefined}>
                                <td className="py-3"><span className="text-xs">{run.rosbagName}</span><div className="font-mono text-[10px] text-muted-foreground">{run.runId}</div></td>
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
                {stats.runs.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">Chưa có lượt phân tích nào.</p> : null}
            </div>
            <p className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground">
                Độ chính xác = Đã phê duyệt / Đã đánh giá.
            </p>
        </SectionCard>
    </>
}
