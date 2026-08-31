"use client"

import { useMemo, useState } from "react"
import {
  ActivityIcon,
  AlertCircleIcon,
  BadgeDollarSignIcon,
  ClockIcon,
  CoinsIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { compact, ms, shortDate } from "@/lib/api"
import type { AnalysisRun } from "@/lib/types"
import { cn } from "@/lib/utils"

/** "—" for zero/missing real data instead of a misleading "$0.00" (ai20k-13 §6.2). */
function costLabel(costUsd: number): string {
  return costUsd > 0 ? `$${costUsd.toFixed(4)}` : "—"
}

interface LLMObservabilityProps {
  runs: AnalysisRun[]
  total: number
  onRefresh?: () => void
}

/**
 * Real per-run LLM usage (model, latency, tokens, cost) from the `runs` table.
 *
 * Replaces a previous tab that displayed fabricated NVIDIA H100/vLLM GPU
 * telemetry with no backing data — this project calls OpenAI/Anthropic over
 * plain HTTP, so there is no GPU, VRAM or decode-queue metric to show. Every
 * number here comes from `GET /api/v1/runs`.
 */
export function LLMObservability({ runs, total, onRefresh }: LLMObservabilityProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [isRefreshing, setIsRefreshing] = useState(false)

  const stats = useMemo(() => {
    const withUsage = runs.filter((r) => r.totalLatencyMs > 0)
    const totalTokens = runs.reduce((sum, r) => sum + r.promptTokens + r.completionTokens, 0)
    const totalCostUsd = runs.reduce((sum, r) => sum + r.costUsd, 0)
    const avgLatencyMs = withUsage.length
      ? withUsage.reduce((sum, r) => sum + r.totalLatencyMs, 0) / withUsage.length
      : 0
    const models = [...new Set(runs.map((r) => r.model).filter(Boolean))]
    return { totalTokens, totalCostUsd, avgLatencyMs, models }
  }, [runs])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return runs
    return runs.filter(
      (r) => r.id.toLowerCase().includes(q) || r.rosbagName.toLowerCase().includes(q) || r.model.toLowerCase().includes(q),
    )
  }, [runs, searchQuery])

  const handleRefresh = async () => {
    if (!onRefresh) return
    setIsRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setTimeout(() => setIsRefreshing(false), 300)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-card/70 p-3.5 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/40 bg-primary/10 text-primary">
            <SparklesIcon className="size-4.5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-foreground">Giám sát LLM (LLM Observability)</span>
              <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                {stats.models.length ? stats.models.join(", ") : "chưa có run nào"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Số liệu thật từ bảng <code className="font-mono">runs</code> — không có phần cứng GPU để đo, dự án gọi LLM qua HTTP.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="h-8 gap-1.5 text-xs font-medium">
          <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
          <span>Làm mới</span>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border border-border/80 bg-card/60 shadow-xs">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tổng số run</span>
              <ActivityIcon className="size-4 text-primary" />
            </div>
            <span className="text-2xl font-bold font-mono text-foreground">{total}</span>
          </CardContent>
        </Card>
        <Card className="border border-border/80 bg-card/60 shadow-xs">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Độ trễ trung bình</span>
              <ClockIcon className="size-4 text-purple-400" />
            </div>
            <span className="text-2xl font-bold font-mono text-foreground">
              {stats.avgLatencyMs > 0 ? ms(stats.avgLatencyMs) : "—"}
            </span>
          </CardContent>
        </Card>
        <Card className="border border-border/80 bg-card/60 shadow-xs">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tổng token</span>
              <CoinsIcon className="size-4 text-amber-400" />
            </div>
            <span className="text-2xl font-bold font-mono text-foreground">
              {stats.totalTokens > 0 ? compact(stats.totalTokens) : "—"}
            </span>
          </CardContent>
        </Card>
        <Card className="border border-border/80 bg-card/60 shadow-xs">
          <CardContent className="p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tổng chi phí</span>
              <BadgeDollarSignIcon className="size-4 text-emerald-400" />
            </div>
            <span className="text-2xl font-bold font-mono text-foreground">{costLabel(stats.totalCostUsd)}</span>
          </CardContent>
        </Card>
      </div>

      <Card className="border border-border/80 bg-card/60 shadow-xs overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/70 py-2.5 px-4 bg-muted/20">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-foreground">
            Lịch sử run ({filtered.length})
          </CardTitle>
          <div className="relative w-full max-w-[220px]">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm theo run, dataset, model…"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <AlertCircleIcon className="mx-auto size-5 text-muted-foreground" />
                <EmptyTitle className="text-sm">Chưa có run nào</EmptyTitle>
                <EmptyDescription className="text-xs">Chạy phân tích trên một dataset để thấy số liệu LLM thật ở đây.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="divide-y divide-border/40 max-h-[480px] overflow-y-auto">
              {filtered.map((run) => (
                <div key={run.id} className="flex flex-wrap items-center gap-3 p-3 text-xs hover:bg-muted/20">
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-mono text-[10px] uppercase shrink-0",
                      run.status === "succeeded" && "border-emerald-500/40 text-emerald-400 bg-emerald-500/10",
                      run.status === "failed" && "border-rose-500/40 text-rose-400 bg-rose-500/10",
                    )}
                  >
                    {run.status}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-foreground truncate">{run.rosbagName}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{run.model || "—"}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground font-mono">{shortDate(run.startedAt)}</p>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 font-mono text-[11px] text-muted-foreground">
                    <span>{run.totalLatencyMs > 0 ? ms(run.totalLatencyMs) : "—"}</span>
                    <span>{run.promptTokens + run.completionTokens > 0 ? `${compact(run.promptTokens + run.completionTokens)} tok` : "—"}</span>
                    <span className="text-foreground font-semibold">{costLabel(run.costUsd)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
