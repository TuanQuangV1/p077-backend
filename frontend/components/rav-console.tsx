"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
    ActivityIcon, ArrowRightIcon, BotIcon, CircleAlertIcon,
    CpuIcon, DatabaseIcon, DownloadIcon, FileTextIcon, GaugeIcon,
    HelpCircleIcon, PlayIcon, RefreshCwIcon, SearchIcon, ServerIcon, ShieldCheckIcon, Trash2Icon, UploadIcon,
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
            toast.error("Không thể tải tập dữ liệu")
        })
    }

    useEffect(() => { fetcher<Overview>("/api/overview").then(setOverview).catch(() => toast.error("Không thể tải tổng quan")); refreshBags() }, [])
    useEffect(() => {
        const run = overview?.recentRuns?.find((x) => x.status === "succeeded") ?? overview?.recentRuns?.[0]
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
    useEffect(() => { if (section === "llm") { fetcher<any>("/api/llm/metrics?windowMin=60").then(setMetrics); fetcher<{ items: LlmRequest[] }>('/api/llm/requests').then((x) => setRequests(x.items)) } }, [section])
    useEffect(() => { if (section === "analysis") { fetcher<{ thresholds: Record<string, number> }>('/api/v1/analysis/thresholds').then((payload) => setThresholds(payload.thresholds)).catch(() => toast.error('Không thể tải ngưỡng phân tích')) } }, [section])

    const selectedAnomaly = anomalies.find((a) => a.id === selected) ?? anomalies[0]
    const selectedResult = aiResults.find((r) => r.anomalyId === selectedAnomaly?.id) ?? aiResults[0]
    const navigate = (href: string) => router.push(href)
    const handleReviewed = (updated: AIResult) => setAiResults((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    const title = ({ dashboard: "Tổng quan", datasets: "Tập dữ liệu", analysis: "Không gian phân tích", review: "Hàng đợi duyệt", reports: "Báo cáo chẩn đoán", llm: "Giám sát LLM", architecture: "Kiến trúc hệ thống" } as Record<string, string>)[section] ?? "RAV-13"

    return <main className="min-h-[calc(100vh-3rem)] bg-background p-4 md:p-6"><div className="mx-auto flex max-w-[1800px] flex-col gap-5">
        <PageHeader title={title} description={section === "analysis" ? `${activeRun?.rosbagName ?? "Chọn lượt chạy"} · bề mặt chẩn đoán đồng bộ` : "Bảng điều khiển chẩn đoán ROS2 Doctor + Agent + LLM"} actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => window.location.reload()}><RefreshCwIcon data-icon="inline-start" />Làm mới</Button>{section === "datasets" ? <Button size="sm" onClick={refreshBags}><UploadIcon data-icon="inline-start" />Làm mới danh sách</Button> : null}</div>} />
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
function Reports({ overview }: { overview: Overview | null }) { return <SectionCard title="Sổ báo cáo" description="Đầu ra có thể kiểm toán được tạo từ chẩn đoán đã duyệt"><div className="flex flex-col gap-3"><div className="flex items-center justify-between border-b border-border pb-3"><div><p className="text-sm font-medium">Đánh giá sự cố điều hướng kho</p><p className="font-mono text-[10px] text-muted-foreground">RPT-2026-071 · 3 vấn đề chính · 2 lượt duyệt</p></div><div className="flex gap-2"><Button variant="outline" size="sm"><DownloadIcon data-icon="inline-start" />JSON</Button><Button size="sm">Xuất bản</Button></div></div><pre className="max-h-72 overflow-auto border border-border bg-muted/20 p-4 font-mono text-xs text-muted-foreground">{json({ generatedAt: "2026-07-31T09:00:00Z", anomalies: overview?.totals.anomalies ?? 0, recommendations: ["Isolate sensor VLAN", "Reserve controller CPU"] })}</pre></div></SectionCard> }
function LlmMonitoring({ metrics, requests }: { metrics: any; requests: LlmRequest[] }) {
    const [tab, setTab] = useState("metrics")
    const [selectedRequest, setSelectedRequest] = useState<LlmRequest | null>(null)
    const a = metrics?.aggregates
    const errors = requests.filter((request) => request.status !== "ok")
    return <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><StatTile label="Tốc độ suy luận" value={a?.tokensPerSec ?? "--"} unit="tok/s" tone="primary" icon={<GaugeIcon className="size-4" />} /><StatTile label="Yêu cầu/giây" value={a?.rps ?? "--"} unit="req/s" /><StatTile label="Độ trễ P95" value={a?.p95 ?? "--"} unit="ms" /><StatTile label="Hàng đợi" value={a?.queueLen ?? "--"} unit="req" /><StatTile label="Độ trễ P99" value={a?.p99 ?? "--"} unit="ms" /></div>
        <Tabs value={tab} onValueChange={setTab} className="w-full"><TabsList><TabsTrigger value="metrics">Chỉ số hệ thống</TabsTrigger><TabsTrigger value="requests">Nhật ký yêu cầu</TabsTrigger><TabsTrigger value="errors">Lỗi <span className="ml-1 font-mono text-[10px]">{errors.length}</span></TabsTrigger></TabsList>
            <TabsContent value="metrics"><div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]"><SectionCard title="Sức khỏe suy luận" description="Cửa sổ hiệu năng trực tiếp"><div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{[["p50", a?.p50], ["p95", a?.p95], ["p99", a?.p99], ["yêu cầu/giây", a?.rps]].map(([label, value]) => <div key={label as string} className="border-l-2 border-primary/50 pl-3"><p className="font-mono text-[10px] uppercase text-muted-foreground">{label}</p><p className="mt-1 font-mono text-xl">{value ?? "--"}</p></div>)}</div><div className="mt-5 h-24 border-b border-border"><div className="flex h-full items-end gap-1 px-1">{(metrics?.points ?? []).slice(-40).map((point: any, index: number) => <div key={index} className="flex-1 bg-primary/60" style={{ height: `${Math.max(8, Math.min(100, point.tokensPerSec / 20))}%` }} />)}</div></div></SectionCard><SectionCard title="Thông tin LLM" description="Cấu hình provider hiện tại"><MetaRow label="provider" value={metrics?.provider?.name ?? "--"} /><MetaRow label="mô hình" value={metrics?.provider?.model ?? "--"} /><MetaRow label="độ dài mô hình tối đa" value={metrics?.provider?.maxModelLen ?? "--"} /><MetaRow label="tokens/s trung bình" value={a?.tokensPerSec ? `${a.tokensPerSec}` : "--"} /></SectionCard></div></TabsContent>
            <TabsContent value="requests"><RequestLog requests={requests} onSelect={setSelectedRequest} /></TabsContent>
            <TabsContent value="errors"><RequestLog requests={errors} onSelect={setSelectedRequest} empty="Không có lỗi LLM trong khoảng thời gian này." /></TabsContent>
        </Tabs>{selectedRequest ? <Card className="border-primary/40"><CardHeader className="flex-row items-center justify-between py-3"><CardTitle className="text-sm">Truy vết {selectedRequest.id}</CardTitle><Button variant="ghost" size="sm" onClick={() => setSelectedRequest(null)}>Đóng</Button></CardHeader><CardContent><div className="grid gap-2 sm:grid-cols-5">{/* Chi tiết pipeline LLM */
                      [["Đầu vào", selectedRequest.promptTokens], ["Tokenizer", selectedRequest.tokenizeMs], ["Prefill", selectedRequest.prefillMs], ["Giải mã", selectedRequest.decodeMs], ["Đầu ra", selectedRequest.completionTokens]].map(([label, value]) => <div key={label as string} className="border border-border p-3"><p className="font-mono text-[10px] uppercase text-muted-foreground">{label}</p><p className="mt-1 font-mono text-sm">{value}{label === "Đầu vào" || label === "Đầu ra" ? " tok" : " ms"}</p></div>)}</div><p className="mt-3 font-mono text-xs text-muted-foreground">{selectedRequest.promptPreview}</p></CardContent></Card> : null}
    </>
}

function RequestLog({ requests, onSelect, empty = "Không có nhật ký yêu cầu." }: { requests: LlmRequest[]; onSelect: (request: LlmRequest) => void; empty?: string }) { return <SectionCard title="Nhật ký truy vết yêu cầu" description="Chọn một yêu cầu để kiểm tra đầu vào → tokenizer → mô hình → đầu ra"><div className="flex flex-col divide-y divide-border">{requests.slice(0, 40).map((request) => <button key={request.id} onClick={() => onSelect(request)} className="py-2 text-left hover:bg-accent/40"><div className="flex items-center gap-2"><StatusLabel status={request.status} /><span className="min-w-0 flex-1 truncate font-mono text-[11px]">{request.promptPreview}</span><span className="font-mono text-[10px] text-muted-foreground">{ms(request.latencyMs)}</span></div><div className="mt-1 flex gap-2 pl-16 font-mono text-[10px] text-muted-foreground"><span>hàng đợi {request.queueMs}ms</span><span>prefill {request.prefillMs}ms</span><span>giải mã {request.decodeMs}ms</span></div></button>)}{requests.length === 0 ? <p className="py-8 text-sm text-muted-foreground">{empty}</p> : null}</div></SectionCard> }
function Architecture() { return <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]"><SectionCard title="Cấu trúc Pipeline" description="Ranh giới vận hành giữa thu thập, chẩn đoán, duyệt và quan sát"><div className="grid gap-3 sm:grid-cols-2">{[[DatabaseIcon, "Lưu trữ đối tượng", "rosbag2 / MCAP files"], [ServerIcon, "Tiến trình FastAPI", "phân tích → lập chỉ mục → phát hiện"], [BotIcon, "Tác nhân + LLM", "chẩn đoán dựa trên bằng chứng"], [ShieldCheckIcon, "Duyệt thủ công", "vòng phản hồi có nhãn"]].map(([Icon, label, detail]) => <div key={label as string} className="flex items-start gap-3 border border-border p-3"><div className="grid size-8 shrink-0 place-items-center bg-primary/10 text-primary"><Icon className="size-4" /></div><div><p className="text-sm font-medium">{label as string}</p><p className="text-xs text-muted-foreground">{detail as string}</p></div></div>)}</div><div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground"><Badge variant="outline">REST</Badge><ArrowRightIcon className="size-3" /><Badge variant="outline">WebSocket /stream</Badge><ArrowRightIcon className="size-3" /><Badge variant="outline">Next.js console</Badge></div></SectionCard><SectionCard title="Tham chiếu hợp đồng" description="Các bề mặt API chính cho dịch vụ Python"><pre className="overflow-auto font-mono text-xs leading-6 text-muted-foreground">{`POST /api/rosbags\nPOST /api/rosbags/:id/parse\nPOST /api/runs\nGET  /api/runs/:id/timeline\nGET  /api/runs/:id/ai\nPOST /api/feedback\nGET  /api/reports\nGET  /api/llm/metrics\nWS   /api/stream`}</pre><Separator className="my-4" /><div className="flex flex-col gap-2 text-xs"><p><span className="text-primary">job.progress</span> cập nhật giai đoạn phân tích</p><p><span className="text-primary">log</span> sự kiện log ROS2 có cấu trúc</p><p><span className="text-primary">simulation.sync</span> đồng bộ thời gian và lựa chọn bất thường</p></div></SectionCard></div> }

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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 flex-1"><StatTile label="Tệp Rosbag đã phân tích" value={totals.analyzed ?? "--"} hint={`${totals.rosbags ?? 0} đã đăng ký · ${totals.hoursOfData ?? 0}h dữ liệu`} icon={<DatabaseIcon className="size-4" />} /><StatTile label="Tỷ lệ lượt chạy có lỗi" value={totals.runsWithIssuesPct ? `${totals.runsWithIssuesPct}%` : "--"} tone="critical" hint={`${totals.anomalies ?? 0} bất thường phát hiện`} icon={<CircleAlertIcon className="size-4" />} /><StatTile label="Thời gian chẩn đoán TB" value={totals.meanTimeToDiagnoseSec ?? "--"} unit="giây" hint="từ phân tích đến kết luận AI" icon={<ActivityIcon className="size-4" />} /><StatTile label="Chi phí suy luận AI" value={totals.inferenceCostUsd ? `$${totals.inferenceCostUsd}` : "--"} hint={`${compact(totals.tokens ?? 0)} tokens tiêu thụ`} icon={<CpuIcon className="size-4" />} /></div>
            {healthScore && <HealthBadge score={healthScore.score} status={healthScore.status as "green" | "yellow" | "red"} />}
        </div>
        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]"><SectionCard title="Xu hướng vận hành 14 ngày" description="Sản lượng ghi, lượng bất thường và độ trễ chẩn đoán p95"><div className="flex h-44 items-end gap-1 border-b border-border px-1">{(overview?.trend ?? []).map((point) => <div key={point.date} className="group relative flex h-full flex-1 items-end gap-0.5"><div className="w-1/2 bg-primary/70" style={{ height: `${Math.max(8, (point.bags / 20) * 100)}%` }} /><div className="w-1/2 bg-critical/70" style={{ height: `${Math.max(5, (point.anomalies / 24) * 100)}%` }} /><span className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-1.5 py-1 font-mono text-[10px] group-hover:block">{point.date} · {point.p95Ms}ms</span></div>)}</div><div className="mt-2 flex gap-4 font-mono text-[10px] text-muted-foreground"><span><i className="mr-1 inline-block size-2 bg-primary/70" />bản ghi</span><span><i className="mr-1 inline-block size-2 bg-critical/70" />bất thường</span><span className="ml-auto">p95 / chi phí theo dõi qua API</span></div></SectionCard><SectionCard title="Lượt chạy gần đây" description="Các tác vụ phân tích gần nhất" actions={<Button variant="ghost" size="sm" onClick={() => navigate("/analysis")}>Mở Không gian làm việc <ArrowRightIcon data-icon="inline-end" /></Button>}><div className="divide-y divide-border">{overview?.recentRuns.map((run) => <button key={run.id} onClick={() => navigate("/analysis")} className="flex w-full items-center gap-3 py-3 text-left hover:bg-accent/30"><StatusLabel status={run.status} /><span className="min-w-0 flex-1 truncate text-sm">{run.rosbagName}</span><span className="font-mono text-xs text-muted-foreground">{run.anomalyCount} lỗi</span></button>)}</div></SectionCard></div>
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
            toast.success("Đã tải rosbag lên", { description: file.name })
            onRefresh()
        } catch (err) {
            const _err = err as Error;
            toast.error("Tải lên thất bại: " + (_err?.message ?? "định dạng tệp không được hỗ trợ"))
        } finally {
            setUploading(false)
            setFileInputKey(k => k + 1)
        }
    }

    const remove = async (bag: Rosbag) => {
        if (!window.confirm(`Xóa ${bag.name}?`)) return
        setBusy(bag.id)
        try {
            await del(`/api/rosbags/${bag.id}`)
            toast.success("Đã xóa tập dữ liệu")
            setSelected((prev) => { const next = new Set(prev); next.delete(bag.id); return next })
            onRefresh()
        } catch {
            toast.error("Không thể xóa tập dữ liệu")
        } finally {
            setBusy(null)
        }
    }

    const analyze = async (bag: Rosbag) => { setBusy(bag.id); try { const result = await post<{ run: AnalysisRun }>("/api/runs", { rosbag_id: bag.id }); toast.success("Đã hoàn tất phân tích", { description: result.run.id }); window.location.assign("/analysis") } catch { toast.error("Không thể chạy phân tích") } finally { setBusy(null) } }
    const analyzeSelected = async () => {
        const ids = filtered.filter((bag) => selected.has(bag.id)).map((bag) => bag.id)
        if (ids.length === 0) return
        setBusy("batch")
        try {
            const results = await Promise.all(ids.map((id) => post<{ run: AnalysisRun }>("/api/runs", { rosbag_id: id })))
            toast.success(`${results.length} lượt phân tích đã xếp hàng`)
            window.location.assign("/analysis")
        } catch {
            toast.error("Không thể xếp hàng phân tích")
        } finally {
            setBusy(null)
        }
    }

    return <SectionCard title="Kho lưu trữ bản ghi" description="Tải lên, xóa và khởi chạy chẩn đoán từ các tệp rosbag đã lưu" actions={<div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={uploading || selected.size === 0} onClick={analyzeSelected}><PlayIcon data-icon="inline-start" />Phân tích mục đã chọn{selected.size ? ` (${selected.size})` : ""}</Button><Button size="sm" disabled={uploading} onClick={() => document.getElementById('file-upload-input')?.click()}><UploadIcon data-icon="inline-start" />{uploading ? "Đang tải lên..." : "Tải rosbag lên"}</Button><input key={fileInputKey} id="file-upload-input" type="file" accept=".db3,.mcap,.bag,.zip" className="hidden" onChange={(e) => upload(e.target.files?.[0])} /></div>}><div className="mb-4 flex max-w-xl items-center gap-2"><SearchIcon className="size-4 text-muted-foreground" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Lọc theo tên tệp..." /></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border font-mono text-[10px] uppercase text-muted-foreground"><tr><th className="pb-2"><Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Chọn tất cả" /></th><th className="pb-2">Bản ghi</th><th className="pb-2">Robot / địa điểm</th><th className="pb-2">Kích thước / thời lượng</th><th className="pb-2">Phân tích</th><th className="pb-2 text-right">Hành động</th></tr></thead><tbody className="divide-y divide-border">{filtered.map((bag) => <tr key={bag.id} className={selected.has(bag.id) ? "bg-accent/30" : undefined}><td className="py-3"><Checkbox checked={selected.has(bag.id)} onCheckedChange={() => toggle(bag.id)} aria-label={`Chọn ${bag.name}`} /></td><td className="py-3 font-mono text-xs">{bag.name}<div className="text-[10px] text-muted-foreground">{bag.messageCount.toLocaleString()} gói tin</div></td><td className="py-3 text-xs">{bag.robotType}<div className="text-muted-foreground">{bag.site}</div></td><td className="py-3 font-mono text-xs">{bytes(bag.sizeBytes)}<div className="text-muted-foreground">{clock(bag.durationSec, false)}</div></td><td className="py-3"><div className="flex flex-col gap-0.5"><StatusLabel status={bag.analysisStatus ?? "not_analyzed"} />{bag.analysisStatus === "succeeded" ? (<span className="font-mono text-[10px] text-muted-foreground flex items-center gap-1">{bag.analysisAnomalyCount ?? 0} lỗi{bag.worstSeverity ? (<SeverityBadge severity={bag.worstSeverity as any} className="ml-1" />) : null}</span>) : null}</div></td><td className="py-3 text-right"><div className="flex justify-end gap-1"><Button size="sm" variant="ghost" disabled={busy === bag.id} onClick={() => analyze(bag)}>Phân tích</Button><Button size="sm" variant="ghost" disabled={busy === bag.id} onClick={() => remove(bag)}><Trash2Icon data-icon="inline-start" />Xóa</Button></div></td></tr>)}</tbody></table></div></SectionCard>
}

function AnalysisWorkspace({ activeRun, rosbag, anomalies, logs, selected, setSelected, lanes, playhead, setPlayhead, selectedResult, view, setView, topicFilter, setTopicFilter, timeRange, setTimeRange, thresholds, setThresholds, savingThresholds, setSavingThresholds, onReviewed, durationSec, startSec, topics }: { activeRun: AnalysisRun | null; rosbag: Rosbag | null; anomalies: Anomaly[]; logs: LogEvent[]; selected: string | null; setSelected: (id: string) => void; lanes: Lane[]; playhead: number; setPlayhead: (time: number) => void; selectedResult?: AIResult; view: { from: number; to: number }; setView: (view: { from: number; to: number }) => void; topicFilter: string; setTopicFilter: (topic: string) => void; timeRange: string; setTimeRange: (range: string) => void; thresholds: Record<string, number>; setThresholds: (thresholds: Record<string, number>) => void; savingThresholds: boolean; setSavingThresholds: (saving: boolean) => void; onReviewed: (result: AIResult) => void; durationSec: number; startSec: number; topics: TopicStat[] }) {
    const duration = durationSec
    const visibleLanes = topicFilter === "all" ? lanes : lanes.filter((lane) => lane.topic === topicFilter)
    // Ranges are relative to the bag's own start — a bag recorded at t=350s
    // would otherwise match nothing against absolute 30s window.
    const visibleAnomalies = timeRange === "all" ? anomalies : anomalies.filter((item) => item.tSec <= startSec + Number(timeRange))
    const saveThresholds = async () => {
        setSavingThresholds(true)
        try {
            const payload = await post<{ thresholds: Record<string, number> }>('/api/v1/analysis/thresholds', { thresholds })
            setThresholds(payload.thresholds)
            toast.success('Đã cập nhật ngưỡng')
        } catch {
            toast.error('Không thể lưu ngưỡng')
        } finally {
            setSavingThresholds(false)
        }
    }
    return <div className="flex min-h-[680px] flex-col gap-3"><div className="flex flex-wrap items-center gap-2 border border-border bg-card p-2"><select value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)} className="h-8 border border-input bg-background px-2 font-mono text-xs"><option value="all">Tất cả topic</option>{lanes.map((lane) => <option key={lane.topic} value={lane.topic}>{lane.topic}</option>)}</select><select value={timeRange} onChange={(e) => { const value = e.target.value; setTimeRange(value); setView({ from: startSec, to: value === "all" ? duration : startSec + Number(value) }) }} className="h-8 border border-input bg-background px-2 font-mono text-xs"><option value="all">Toàn bộ lượt chạy</option><option value="30">30 giây đầu</option><option value="60">60 giây đầu</option></select><span className="ml-auto font-mono text-[10px] text-muted-foreground">{({ parse: "phân tách", index: "lập chỉ mục", detect: "phát hiện", diagnose: "chẩn đoán", report: "lập báo cáo", done: "hoàn tất", loading: "đang tải", queued: "đang chờ", failed: "thất bại", succeeded: "thành công", pending: "chờ duyệt" } as Record<string, string>)[activeRun?.stage ?? "loading"] ?? activeRun?.stage ?? "đang tải"} · {activeRun?.progress ?? 0}% · {lanes.length} làn</span></div><Card data-testid="thresholds-panel"><CardContent className="flex flex-wrap items-end gap-3 p-3"><label className="grid gap-1 text-xs text-muted-foreground">Ngưỡng khoảng trống tần số (giây)<Input data-testid="threshold-frequency-gap" type="number" min="0" step="0.01" value={thresholds.frequency_gap_min_threshold_sec ?? ""} onChange={(event) => setThresholds({ ...thresholds, frequency_gap_min_threshold_sec: Number(event.target.value) })} className="h-8 w-44 font-mono text-xs" /></label><label className="grid gap-1 text-xs text-muted-foreground">Ngưỡng nút im lặng (giây)<Input type="number" min="0" step="0.1" value={thresholds.silent_node_min_span_sec ?? ""} onChange={(event) => setThresholds({ ...thresholds, silent_node_min_span_sec: Number(event.target.value) })} className="h-8 w-44 font-mono text-xs" /></label><Button data-testid="save-thresholds" size="sm" variant="outline" disabled={savingThresholds || Object.keys(thresholds).length === 0} onClick={saveThresholds}>{savingThresholds ? "Đang lưu..." : "Lưu ngưỡng"}</Button></CardContent></Card><AnalysisHealthPanel activeRunId={activeRun?.id ?? null} rosbag={rosbag} anomalies={anomalies} logs={logs} topics={topics} onSelectAnomaly={(id) => { setSelected(id); setPlayhead(anomalies.find(a => a.id === id)?.tSec ?? 0) }} onSeek={setPlayhead} /><div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[230px_minmax(0,1fr)_380px]"><Card className="min-h-0 overflow-hidden"><CardHeader className="border-b border-border py-3"><CardTitle className="text-sm">Phát hiện <span className="font-mono text-[10px] text-muted-foreground">{visibleAnomalies.length}</span></CardTitle></CardHeader><AnomalyList anomalies={visibleAnomalies} selectedId={selected} severities={[]} onSeveritiesChange={() => { }} onSelect={(anomaly) => { setSelected(anomaly.id); setPlayhead(anomaly.tSec) }} /></Card><Card className="min-w-0 overflow-hidden"><CardHeader className="flex-row items-center justify-between border-b border-border py-3"><div><CardTitle className="text-sm">Dòng thời gian tin nhắn</CardTitle><p className="font-mono text-[10px] text-muted-foreground">{activeRun?.rosbagName ?? "Đang tải lượt chạy"} · kéo để cuộn · giữ Shift để kéo</p></div><Badge variant="outline" data-testid="timeline-playhead" className="font-mono text-[10px]">{clock(playhead)}</Badge></CardHeader><CardContent className="p-0 pt-3"><TimelineCanvas durationSec={duration} lanes={visibleLanes} anomalies={visibleAnomalies} playhead={playhead} view={view} selectedAnomalyId={selected} onScrub={setPlayhead} onViewChange={setView} onSelectAnomaly={setSelected} /></CardContent></Card><div className="min-h-0 overflow-auto space-y-3">{selectedResult ? <AIConclusion result={selectedResult} anomaly={visibleAnomalies.find((item) => item.id === selectedResult.anomalyId)} onSeek={setPlayhead} onReviewed={onReviewed} /> : <Card><CardContent className="p-5 text-sm text-muted-foreground">Chọn một phát hiện để xem kết luận của AI.</CardContent></Card>}</div></div></div>
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

    if (failed) return <SectionCard title="Độ chính xác Agent" description="Tổng hợp quyết định Human-in-the-loop"><p className="py-8 text-sm text-muted-foreground">Không thể tải thống kê duyệt.</p></SectionCard>
    if (!stats) return <SectionCard title="Độ chính xác Agent" description="Tổng hợp quyết định Human-in-the-loop"><p className="py-8 text-sm text-muted-foreground">Đang tải thống kê duyệt...</p></SectionCard>

    const copyJson = () => {
        navigator.clipboard?.writeText(json(stats))
        toast.success("Đã sao chép báo cáo độ chính xác dạng JSON")
    }

    return <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Độ chính xác Agent" value={pct(stats.accuracy)} tone={stats.accuracy !== null && stats.accuracy < 0.7 ? "critical" : "primary"} hint={`${stats.approved} đã duyệt trên ${stats.reviewed} đã xem xét`} icon={<ShieldCheckIcon className="size-4" />} />
            <StatTile label="Đã xem xét" value={stats.reviewed} hint={`${stats.pending} vẫn chờ`} icon={<FileTextIcon className="size-4" />} />
            <StatTile label="Bị từ chối" value={stats.rejected} tone="critical" hint="kết luận bị đánh giá sai" icon={<CircleAlertIcon className="size-4" />} />
            <StatTile label="Đã sửa" value={stats.edited} hint="nguyên nhân gốc được người duyệt sửa" icon={<ActivityIcon className="size-4" />} />
        </div>
        <SectionCard
            title="Độ chính xác theo lượt chạy"
            description="Quyết định được ghi nhận bởi kỹ sư cho mỗi lượt phân tích"
            actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={load}><RefreshCwIcon data-icon="inline-start" />Làm mới</Button><Button variant="outline" size="sm" onClick={copyJson}><DownloadIcon data-icon="inline-start" />JSON</Button></div>}
        >
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <thead className="border-b border-border font-mono text-[10px] uppercase text-muted-foreground">
                        <tr><th className="pb-2">Lượt chạy</th><th className="pb-2 text-right">Phát hiện</th><th className="pb-2 text-right">Đã xem xét</th><th className="pb-2 text-right">Đã duyệt</th><th className="pb-2 text-right">Từ chối</th><th className="pb-2 text-right">Đã sửa</th><th className="pb-2 text-right">Độ chính xác</th></tr>
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
                Độ chính xác = đã duyệt / đã xem xét. Recall không được báo cáo: cần nhãn ground-truth cho
                các bất thường mà agent không phát hiện, điều mà hàng đợi duyệt không thể quan sát.
            </p>
        </SectionCard>
    </>
}
