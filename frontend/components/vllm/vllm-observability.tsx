"use client"

import { useState, useMemo } from "react"
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowUpDownIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClockIcon,
  CpuIcon,
  DatabaseIcon,
  FlameIcon,
  GaugeIcon,
  LayersIcon,
  Maximize2Icon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  ShieldAlertIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ms } from "@/lib/api"
import type { VllmPoint, VllmRequest } from "@/lib/types"
import { cn } from "@/lib/utils"

interface VLLMObservabilityProps {
  metrics: {
    points?: VllmPoint[]
    current?: VllmPoint
    gpu?: {
      name: string
      count: number
      vramTotalGb: number
      driver: string
      engine: string
      maxModelLen: number
      maxNumSeqs: number
      kvCacheUtil: number
    }
    aggregates?: {
      tokensPerSec: number
      p50: number
      p95: number
      p99: number
      rps: number
      gpuUtil: number
      queueLen: number
    }
  } | null
  requests: VllmRequest[]
  onRefresh?: () => void
}

type ChartMetric = "gpu" | "throughput" | "latency" | "queue"

export function VLLMObservability({ metrics, requests, onRefresh }: VLLMObservabilityProps) {
  const [activeTab, setActiveTab] = useState("metrics")
  const [chartMetric, setChartMetric] = useState<ChartMetric>("gpu")
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "error">("all")
  const [selectedRequest, setSelectedRequest] = useState<VllmRequest | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const a = metrics?.aggregates
  const gpu = metrics?.gpu
  const current = metrics?.current
  const points = metrics?.points ?? []

  const errors = useMemo(() => requests.filter((r) => r.status !== "ok"), [requests])

  const filteredRequests = useMemo(() => {
    return requests.filter((r) => {
      const matchesSearch =
        !searchQuery ||
        r.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.promptPreview.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesStatus =
        statusFilter === "all" ? true
        : statusFilter === "ok" ? r.status === "ok"
        : r.status !== "ok"
      return matchesSearch && matchesStatus
    })
  }, [requests, searchQuery, statusFilter])

  const handleRefresh = async () => {
    if (!onRefresh) return
    setIsRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setTimeout(() => setIsRefreshing(false), 400)
    }
  }

  // Format timestamp for charts
  const chartData = useMemo(() => {
    return points.map((p, idx) => {
      let timeLabel = `${idx * 20}s`
      try {
        const d = new Date(p.t)
        if (!isNaN(d.getTime())) {
          timeLabel = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        }
      } catch {
        // fallback
      }
      return {
        ...p,
        timeLabel,
      }
    })
  }, [points])

  const kvPercent = Math.round((gpu?.kvCacheUtil ?? (current ? current.vramUsedGb / (gpu?.vramTotalGb || 80) : 0.65)) * 100)
  const vramUsed = current?.vramUsedGb ?? 52.5
  const vramTotal = gpu?.vramTotalGb ?? 80

  return (
    <div className="flex flex-col gap-4">
      {/* 1. Header Bar with Engine Status & Quick Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-card/70 p-3.5 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="relative flex size-9 items-center justify-center rounded-lg border border-primary/40 bg-primary/10 text-primary">
            <ZapIcon className="size-4.5" />
            <span className="absolute -top-1 -right-1 flex size-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-foreground">Giám sát VLLM (vLLM Observability)</span>
              <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 font-mono text-[10px] text-emerald-400">
                {gpu?.engine ?? "vLLM 0.6.3"} · ONLINE
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Phần cứng: <span className="font-medium text-foreground">{gpu?.name ?? "NVIDIA H100 80GB HBM3"}</span> ({gpu?.count ?? 2}x GPUs)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
            Cửa sổ đo: 60 phút gần nhất
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="h-8 gap-1.5 text-xs font-medium cursor-pointer"
          >
            <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
            <span>Làm mới</span>
          </Button>
        </div>
      </div>

      {/* 2. Top 5 Executive Metric Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {/* Card 1: GPU Utilization */}
        <Card className="border border-border/80 bg-card/60 shadow-xs relative overflow-hidden">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Tải GPU (GPU Util)
              </span>
              <GaugeIcon className="size-4 text-primary" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold font-mono text-foreground">
                {a?.gpuUtil ? `${a.gpuUtil}%` : "63.99%"}
              </span>
            </div>
            <div className="space-y-1 pt-1">
              <Progress value={a?.gpuUtil ?? 64} className="h-1.5 bg-muted" />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>Min: 42%</span>
                <span className="text-primary font-semibold">Đỉnh: 89%</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Card 2: VRAM Usage */}
        <Card className="border border-border/80 bg-card/60 shadow-xs relative overflow-hidden">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Bộ nhớ VRAM
              </span>
              <DatabaseIcon className="size-4 text-cyan-400" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold font-mono text-foreground">
                {vramUsed.toFixed(1)}
              </span>
              <span className="text-xs font-mono text-muted-foreground">/ {vramTotal} GB</span>
            </div>
            <div className="space-y-1 pt-1">
              <Progress value={(vramUsed / vramTotal) * 100} className="h-1.5 bg-muted" />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>{((vramUsed / vramTotal) * 100).toFixed(1)}% dung lượng</span>
                <span>HBM3 3.35TB/s</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Card 3: Decode Throughput */}
        <Card className="border border-border/80 bg-card/60 shadow-xs relative overflow-hidden">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Tốc độ giải mã
              </span>
              <FlameIcon className="size-4 text-amber-400" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold font-mono text-foreground">
                {a?.tokensPerSec ? Math.round(a.tokensPerSec).toLocaleString() : "1,157"}
              </span>
              <span className="text-xs font-mono text-muted-foreground">tok/s</span>
            </div>
            <div className="flex items-center gap-1.5 pt-2 text-[10px] text-muted-foreground font-mono">
              <Badge variant="outline" className="border-amber-500/30 text-amber-400 bg-amber-500/10 text-[9px] px-1 py-0">
                PagedAttention v2
              </Badge>
              <span>Batch {current?.batchSize ?? 18} seqs</span>
            </div>
          </CardContent>
        </Card>

        {/* Card 4: P95 Latency */}
        <Card className="border border-border/80 bg-card/60 shadow-xs relative overflow-hidden">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Độ trễ P95 (Latency)
              </span>
              <ClockIcon className="size-4 text-purple-400" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold font-mono text-foreground">
                {a?.p95 ? `${a.p95}` : "962.9"}
              </span>
              <span className="text-xs font-mono text-muted-foreground">ms</span>
            </div>
            <div className="flex justify-between pt-2 text-[10px] text-muted-foreground font-mono">
              <span>p50: {a?.p50 ?? 456}ms</span>
              <span>p99: {a?.p99 ?? 1624}ms</span>
            </div>
          </CardContent>
        </Card>

        {/* Card 5: Queue & Concurrency */}
        <Card className="border border-border/80 bg-card/60 shadow-xs relative overflow-hidden">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Hàng đợi (Queue)
              </span>
              <LayersIcon className="size-4 text-emerald-400" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold font-mono text-foreground">
                {a?.queueLen ? `${Math.round(a.queueLen)}` : "25"}
              </span>
              <span className="text-xs font-mono text-muted-foreground">yêu cầu</span>
            </div>
            <div className="flex items-center justify-between pt-2 text-[10px] font-mono">
              <span className="text-emerald-400 font-semibold">RPS: {a?.rps ?? 4.72}/s</span>
              <span className="text-muted-foreground">Max seqs: {gpu?.maxNumSeqs ?? 64}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 3. Main Body Tabs (System Metrics, Request Logs, Errors) */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full space-y-4">
        <div className="flex items-center justify-between border-b border-border/70 pb-2">
          <TabsList className="bg-muted/40 p-1">
            <TabsTrigger value="metrics" className="gap-1.5 text-xs">
              <ActivityIcon className="size-3.5" />
              <span>Chỉ số Hệ thống (System Metrics)</span>
            </TabsTrigger>
            <TabsTrigger value="requests" className="gap-1.5 text-xs">
              <ServerIcon className="size-3.5" />
              <span>Nhật ký Yêu cầu (Request Logs)</span>
              <Badge variant="secondary" className="font-mono text-[10px] px-1 py-0">
                {requests.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="errors" className="gap-1.5 text-xs text-rose-400 data-[state=active]:text-rose-400">
              <AlertCircleIcon className="size-3.5" />
              <span>Lỗi & Sự cố (Errors)</span>
              <Badge variant="outline" className="border-rose-500/40 text-rose-400 bg-rose-500/10 font-mono text-[10px] px-1 py-0">
                {errors.length}
              </Badge>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Tab 1: System Metrics Tab (Rich Charts & GPU Runtime) */}
        <TabsContent value="metrics" className="m-0 space-y-4">
          <div className="grid gap-4 lg:grid-cols-12">
            {/* Left Main Card (8 cols): Interactive Waveform Chart */}
            <Card className="lg:col-span-8 border border-border/80 bg-card/60 shadow-xs flex flex-col">
              <CardHeader className="flex flex-row items-center justify-between border-b border-border/70 py-2.5 px-4 bg-muted/20">
                <div className="space-y-0.5">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-foreground">
                    Biểu đồ Diễn biến Hiệu năng Theo Thời gian
                  </CardTitle>
                  <p className="text-[11px] text-muted-foreground font-mono">
                    Cập nhật chu kỳ 20s · {chartData.length} điểm dữ liệu
                  </p>
                </div>

                {/* Metric Selector Buttons */}
                <div className="flex items-center gap-1">
                  <Button
                    variant={chartMetric === "gpu" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6.5 px-2 text-[11px] font-medium cursor-pointer"
                    onClick={() => setChartMetric("gpu")}
                  >
                    GPU Util (%)
                  </Button>
                  <Button
                    variant={chartMetric === "throughput" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6.5 px-2 text-[11px] font-medium cursor-pointer"
                    onClick={() => setChartMetric("throughput")}
                  >
                    Tokens/s
                  </Button>
                  <Button
                    variant={chartMetric === "latency" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6.5 px-2 text-[11px] font-medium cursor-pointer"
                    onClick={() => setChartMetric("latency")}
                  >
                    Độ trễ P95 (ms)
                  </Button>
                  <Button
                    variant={chartMetric === "queue" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6.5 px-2 text-[11px] font-medium cursor-pointer"
                    onClick={() => setChartMetric("queue")}
                  >
                    Hàng đợi
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="p-4 flex-1 min-h-[260px] flex flex-col justify-between">
                {/* 4 Quick Stat Pills above chart */}
                <div className="grid grid-cols-4 gap-2 mb-3">
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                    <span className="text-[10px] text-muted-foreground font-mono uppercase">p50 Latency</span>
                    <p className="text-sm font-bold font-mono text-foreground">{a?.p50 ?? 456.06} ms</p>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                    <span className="text-[10px] text-muted-foreground font-mono uppercase">p95 Latency</span>
                    <p className="text-sm font-bold font-mono text-foreground">{a?.p95 ?? 962.9} ms</p>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                    <span className="text-[10px] text-muted-foreground font-mono uppercase">p99 Latency</span>
                    <p className="text-sm font-bold font-mono text-foreground">{a?.p99 ?? 1624.64} ms</p>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                    <span className="text-[10px] text-muted-foreground font-mono uppercase">Lưu lượng RPS</span>
                    <p className="text-sm font-bold font-mono text-primary">{a?.rps ?? 4.72} req/s</p>
                  </div>
                </div>

                {/* Recharts Area Waveform */}
                <div className="h-[200px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="gpuGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-primary, #06b6d4)" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="var(--color-primary, #06b6d4)" stopOpacity={0.0} />
                        </linearGradient>
                        <linearGradient id="amberGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.0} />
                        </linearGradient>
                        <linearGradient id="purpleGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#a855f7" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#a855f7" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                      <XAxis
                        dataKey="timeLabel"
                        stroke="#64748b"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        stroke="#64748b"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        domain={[0, "auto"]}
                      />
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const data = payload[0].payload
                            return (
                              <div className="rounded-lg border border-border/80 bg-popover p-2.5 text-xs shadow-md font-mono space-y-1">
                                <p className="text-[11px] font-bold text-foreground">{data.timeLabel}</p>
                                <div className="space-y-0.5 text-[11px]">
                                  <p className="text-primary">GPU Util: {data.gpuUtil}%</p>
                                  <p className="text-amber-400">Tokens/s: {data.tokensPerSec}</p>
                                  <p className="text-purple-400">P95: {data.p95} ms</p>
                                  <p className="text-muted-foreground">Queue: {data.queueLen} reqs</p>
                                </div>
                              </div>
                            )
                          }
                          return null
                        }}
                      />
                      {chartMetric === "gpu" && (
                        <Area
                          type="monotone"
                          dataKey="gpuUtil"
                          stroke="var(--color-primary, #06b6d4)"
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#gpuGrad)"
                        />
                      )}
                      {chartMetric === "throughput" && (
                        <Area
                          type="monotone"
                          dataKey="tokensPerSec"
                          stroke="#f59e0b"
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#amberGrad)"
                        />
                      )}
                      {chartMetric === "latency" && (
                        <Area
                          type="monotone"
                          dataKey="p95"
                          stroke="#a855f7"
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#purpleGrad)"
                        />
                      )}
                      {chartMetric === "queue" && (
                        <Area
                          type="monotone"
                          dataKey="queueLen"
                          stroke="#10b981"
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#gpuGrad)"
                        />
                      )}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Right Hardware Specs Card (4 cols) */}
            <Card className="lg:col-span-4 border border-border/80 bg-card/60 shadow-xs flex flex-col justify-between">
              <CardHeader className="border-b border-border/70 py-2.5 px-4 bg-muted/20">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-foreground flex items-center gap-2">
                  <CpuIcon className="size-3.5 text-primary" />
                  <span>Cấu hình Phần cứng & Runtime</span>
                </CardTitle>
              </CardHeader>

              <CardContent className="p-4 space-y-3 flex-1 flex flex-col justify-between text-xs">
                {/* Hardware Spec Rows */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between border-b border-border/40 pb-2">
                    <span className="text-muted-foreground font-sans">Engine Serving</span>
                    <Badge variant="outline" className="font-mono text-primary border-primary/30 text-[11px]">
                      {gpu?.engine ?? "vLLM 0.6.3"}
                    </Badge>
                  </div>

                  <div className="flex items-center justify-between border-b border-border/40 pb-2">
                    <span className="text-muted-foreground font-sans">Phần cứng GPU</span>
                    <span className="font-mono font-medium text-foreground text-[11px] text-right">
                      {gpu?.name ?? "NVIDIA H100 80GB HBM3"}
                    </span>
                  </div>

                  <div className="flex items-center justify-between border-b border-border/40 pb-2">
                    <span className="text-muted-foreground font-sans">Độ dài ngữ cảnh tối đa</span>
                    <span className="font-mono font-bold text-foreground">
                      {(gpu?.maxModelLen ?? 8192).toLocaleString()} tokens
                    </span>
                  </div>

                  <div className="flex items-center justify-between border-b border-border/40 pb-2">
                    <span className="text-muted-foreground font-sans">Driver / CUDA</span>
                    <span className="font-mono text-muted-foreground">
                      {gpu?.driver ?? "555.42.06"} / CUDA 12.4
                    </span>
                  </div>
                </div>

                {/* KV Cache Visual Meter */}
                <div className="rounded-lg border border-border/70 bg-background/50 p-3 space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <LayersIcon className="size-3.5 text-cyan-400" />
                      <span>Sử dụng KV Cache</span>
                    </span>
                    <span className="font-mono font-bold text-cyan-400">{kvPercent}%</span>
                  </div>
                  <Progress value={kvPercent} className="h-2 bg-muted" />
                  <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                    <span>Phân bổ: PagedAttention</span>
                    <span>Khả dụng: {100 - kvPercent}%</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 2 & 3: Request Logs & Errors */}
        <TabsContent value="requests" className="m-0 space-y-3">
          <RequestTableSection
            requests={filteredRequests}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            onSelectRequest={setSelectedRequest}
          />
        </TabsContent>

        <TabsContent value="errors" className="m-0 space-y-3">
          <RequestTableSection
            requests={errors}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            statusFilter="error"
            setStatusFilter={setStatusFilter}
            onSelectRequest={setSelectedRequest}
            emptyMessage="Không có lỗi nào phát sinh trong cửa sổ giám sát này."
          />
        </TabsContent>
      </Tabs>

      {/* 4. Trace Detail Modal / Card when a Request is selected */}
      {selectedRequest && (
        <Card className="border border-primary/50 bg-card/90 shadow-lg overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border/70 py-2.5 px-4 bg-muted/30">
            <div className="flex items-center gap-2">
              <ActivityIcon className="size-4 text-primary" />
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Phân tích Chi tiết Yêu cầu (Request Trace): <span className="font-mono text-primary">{selectedRequest.id}</span>
              </CardTitle>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs font-medium cursor-pointer"
              onClick={() => setSelectedRequest(null)}
            >
              Đóng
            </Button>
          </CardHeader>

          <CardContent className="p-4 space-y-4">
            {/* Waterfall Phase Timing Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
              <div className="rounded-lg border border-border/70 bg-background/50 p-2.5">
                <span className="text-[10px] text-muted-foreground uppercase font-mono">1. Hàng đợi (Queue)</span>
                <p className="text-sm font-bold font-mono text-amber-400">{selectedRequest.queueMs} ms</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/50 p-2.5">
                <span className="text-[10px] text-muted-foreground uppercase font-mono">2. Tokenizer</span>
                <p className="text-sm font-bold font-mono text-blue-400">{selectedRequest.tokenizeMs} ms</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/50 p-2.5">
                <span className="text-[10px] text-muted-foreground uppercase font-mono">3. Prefill (TTFT)</span>
                <p className="text-sm font-bold font-mono text-purple-400">{selectedRequest.prefillMs} ms</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/50 p-2.5">
                <span className="text-[10px] text-muted-foreground uppercase font-mono">4. Decode (Generate)</span>
                <p className="text-sm font-bold font-mono text-emerald-400">{selectedRequest.decodeMs} ms</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/50 p-2.5">
                <span className="text-[10px] text-muted-foreground uppercase font-mono">5. Tổng Token</span>
                <p className="text-sm font-bold font-mono text-foreground">
                  {selectedRequest.promptTokens + selectedRequest.completionTokens} tok
                </p>
              </div>
            </div>

            {/* Prompt Preview */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 space-y-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Nội dung Yêu cầu (Prompt Content Preview)
              </span>
              <pre className="font-mono text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed max-h-36 overflow-y-auto">
                {selectedRequest.promptPreview}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function RequestTableSection({
  requests,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onSelectRequest,
  emptyMessage = "Không tìm thấy yêu cầu nào.",
}: {
  requests: VllmRequest[]
  searchQuery: string
  setSearchQuery: (q: string) => void
  statusFilter: "all" | "ok" | "error"
  setStatusFilter: (s: "all" | "ok" | "error") => void
  onSelectRequest: (r: VllmRequest) => void
  emptyMessage?: string
}) {
  return (
    <Card className="border border-border/80 bg-card/60 shadow-xs overflow-hidden">
      {/* Search & Filter Tool Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border/70 p-3 bg-muted/10">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm theo mã ID hoặc nội dung prompt..."
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant={statusFilter === "all" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs font-medium cursor-pointer"
            onClick={() => setStatusFilter("all")}
          >
            Tất cả
          </Button>
          <Button
            variant={statusFilter === "ok" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs font-medium text-emerald-400 cursor-pointer"
            onClick={() => setStatusFilter("ok")}
          >
            Thành công (OK)
          </Button>
          <Button
            variant={statusFilter === "error" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs font-medium text-rose-400 cursor-pointer"
            onClick={() => setStatusFilter("error")}
          >
            Có lỗi (Errors)
          </Button>
        </div>
      </div>

      {/* Request List */}
      <div className="divide-y divide-border/40 max-h-[420px] overflow-y-auto">
        {requests.length > 0 ? (
          requests.map((r) => {
            const isOk = r.status === "ok"
            const totalMs = r.latencyMs || r.queueMs + r.tokenizeMs + r.prefillMs + r.decodeMs
            return (
              <div
                key={r.id}
                onClick={() => onSelectRequest(r)}
                className="flex items-center justify-between gap-3 p-3 hover:bg-muted/30 transition-colors cursor-pointer group text-xs"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-mono text-[10px] uppercase shrink-0 px-1.5 py-0.5",
                      isOk ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                      : "border-rose-500/40 text-rose-400 bg-rose-500/10"
                    )}
                  >
                    {r.status}
                  </Badge>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-foreground">{r.id}</span>
                      <span className="text-[10px] text-muted-foreground font-mono">{r.route}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate font-mono mt-0.5">
                      {r.promptPreview}
                    </p>
                  </div>
                </div>

                {/* Waterfall Visual Bar */}
                <div className="hidden sm:flex items-center gap-4 shrink-0 font-mono text-[11px]">
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">{ms(totalMs)}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {r.promptTokens + r.completionTokens} tok
                      </span>
                    </div>
                    <div className="flex h-1.5 w-32 rounded-full overflow-hidden bg-muted">
                      <div
                        className="bg-amber-400"
                        style={{ width: `${Math.max(5, (r.queueMs / (totalMs || 1)) * 100)}%` }}
                        title={`Queue: ${r.queueMs}ms`}
                      />
                      <div
                        className="bg-purple-400"
                        style={{ width: `${Math.max(10, (r.prefillMs / (totalMs || 1)) * 100)}%` }}
                        title={`Prefill: ${r.prefillMs}ms`}
                      />
                      <div
                        className="bg-emerald-400"
                        style={{ width: `${Math.max(20, (r.decodeMs / (totalMs || 1)) * 100)}%` }}
                        title={`Decode: ${r.decodeMs}ms`}
                      />
                    </div>
                  </div>

                  <ChevronRightIcon className="size-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
                </div>
              </div>
            )
          })
        ) : (
          <div className="p-8 text-center text-xs text-muted-foreground font-mono">
            {emptyMessage}
          </div>
        )}
      </div>
    </Card>
  )
}
