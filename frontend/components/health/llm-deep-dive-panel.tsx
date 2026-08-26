"use client"

import { useEffect, useState } from "react"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CheckCircleIcon,
  ChevronRightIcon,
  ClockIcon,
  DownloadIcon,
  HelpCircleIcon,
  LoaderIcon,
  RefreshCwIcon,
  SlidersIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Anomaly, HealthSummary, LLMDeepDiveResult } from "@/lib/types"

/**
 * Deterministic fallback used while the deep-dive endpoint isn't wired to a
 * live LLM: computed client-side from data already on hand.
 */
function generateFallbackAnalysis(healthScore: number, anomalies: Anomaly[]): LLMDeepDiveResult {
  if (anomalies.length === 0) {
    return {
      summary: "Không có bất thường nào được ghi nhận. Hệ thống đạt chuẩn vận hành.",
      explanation: [
        "Tất cả chỉ số viễn trắc nằm trong phạm vi định mức an toàn",
        "Tần số xuất bản và độ trễ các kênh cảm biến duy trì ổn định",
      ],
      suggestions: [
        "Duy trì giám sát định kỳ trong các phiên hoạt động tiếp theo",
        "Kiểm tra cảm biến định kỳ theo quy trình tiêu chuẩn",
      ],
      confidence: 0.95,
      priority: "low",
      affected_components: [],
    }
  }

  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const a of anomalies) {
    if (a.severity in severityCounts) severityCounts[a.severity as keyof typeof severityCounts]++
  }

  const explanations: string[] = []
  const suggestions: string[] = []
  const components: string[] = []

  if (severityCounts.critical > 0) {
    explanations.push(`Phát hiện ${severityCounts.critical} sự cố nghiêm trọng cần xử lý khẩn cấp`)
    suggestions.push("Kiểm tra trạng thái tiến trình (node status) và cô lập nguồn phát sinh lỗi")
    suggestions.push("Kiểm tra tải CPU/RAM và độ trễ hàng đợi truyền nhận gói tin")
    components.push("system_critical")
  }
  if (severityCounts.high > 0) {
    explanations.push(`Phát hiện ${severityCounts.high} bất thường mức độ cao làm giảm độ tin cậy`)
    suggestions.push("Kiểm tra bộ đệm buffer truyền nhận và độ trễ xuất bản của node")
    suggestions.push("Giám sát độ ổn định của đường truyền dữ liệu cảm biến")
    if (!components.includes("system_critical")) components.push("diagnostics")
  }

  const topicCounts = new Map<string, number>()
  for (const a of anomalies) {
    for (const topic of a.topics) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
  }
  const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (topTopics.length > 0) {
    explanations.push(`Kênh dữ liệu ảnh hưởng chính: ${topTopics.map(([t]) => t).join(", ")}`)
  }

  const priority = severityCounts.critical > 0 ? "critical"
    : severityCounts.high > 0 ? "high"
    : severityCounts.medium > 0 ? "medium"
    : "low"
  const confidence = severityCounts.critical > 0 ? 0.9
    : severityCounts.high > 0 ? 0.8
    : severityCounts.medium > 0 ? 0.7
    : 0.6

  return {
    summary: `Health Score ${healthScore}/100: ${severityCounts.critical + severityCounts.high} critical/high issues, ${severityCounts.medium + severityCounts.low} medium/low issues detected`,
    explanation: explanations,
    suggestions: [...new Set(suggestions)],
    confidence,
    priority: priority as LLMDeepDiveResult["priority"],
    affected_components: [...new Set(components)],
  }
}

interface LLMDeepDivePanelProps {
  health: HealthSummary | null
  activeRunId: string | null
  anomalies: Anomaly[]
  onSelectAnomaly?: (id: string) => void
}

const SEVERITY_BADGES: Record<string, { label: string; className: string }> = {
  critical: { label: "Nghiêm trọng", className: "border-red-500/40 bg-red-500/10 text-red-400 font-semibold" },
  high: { label: "Mức độ cao", className: "border-orange-500/40 bg-orange-500/10 text-orange-400 font-semibold" },
  medium: { label: "Cảnh báo", className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400 font-semibold" },
  low: { label: "Bình thường", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 font-semibold" },
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <LoaderIcon className="size-4 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">Đang tổng hợp dữ liệu chẩn đoán...</span>
      </div>
      <div className="h-36 animate-pulse rounded-lg bg-muted/40" />
    </div>
  )
}

function EmptyState({ score }: { score: number }) {
  return (
    <div className="flex flex-col items-center justify-center p-6 text-center">
      <CheckCircleIcon className="size-10 text-emerald-500 mb-2" />
      <h3 className="text-sm font-semibold text-foreground">Hệ thống ổn định</h3>
      <p className="mt-1 text-xs text-muted-foreground font-mono">
        Điểm sức khỏe {score}/100 - không phát hiện sự cố nghiêm trọng.
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Tất cả các kênh cảm biến và thông số viễn trắc đều hoạt động đạt chuẩn kỹ thuật.
      </p>
    </div>
  )
}

export function LLMDeepDivePanel({
  health,
  activeRunId,
  anomalies,
  onSelectAnomaly,
}: LLMDeepDivePanelProps) {
  const [deepDive, setDeepDive] = useState<LLMDeepDiveResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isAutoTriggered, setIsAutoTriggered] = useState(false)

  const score = health?.health_score ?? 0
  const triggerLLM = health?.trigger_llm_deep_dive ?? false

  useEffect(() => {
    if (triggerLLM && activeRunId && !deepDive && !isLoading) {
      setIsAutoTriggered(true)
      triggerDeepDive()
    }
  }, [triggerLLM, activeRunId])

  const triggerDeepDive = async () => {
    if (!activeRunId || isLoading || !health) return

    setIsLoading(true)
    try {
      setDeepDive(generateFallbackAnalysis(health.health_score, anomalies))
    } finally {
      setIsLoading(false)
    }
  }

  const exportJSON = () => {
    const data = {
      health,
      deepDive,
      anomalies,
      exportedAt: new Date().toISOString(),
    }
    const runLabel = activeRunId ?? new Date().toISOString()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `chandoan-${runLabel}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 0)
    toast.success("Đã xuất dữ liệu chẩn đoán")
  }

  if (!health) {
    return (
      <Card className="border border-border/80 bg-card/70">
        <CardHeader className="py-2.5 px-4 border-b border-border/60">
          <CardTitle className="text-xs font-semibold text-foreground">
            LLM Deep-Dive Analysis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LoadingSkeleton />
        </CardContent>
      </Card>
    )
  }

  if (score >= 80 && !deepDive) {
    return (
      <Card className="border border-border/80 bg-card/70">
        <CardHeader className="py-2.5 px-4 border-b border-border/60">
          <CardTitle className="flex items-center justify-between text-xs font-semibold text-foreground">
            <span>LLM Deep-Dive Analysis</span>
            <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground font-normal">
              Tự động giám sát
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState score={score} />
        </CardContent>
      </Card>
    )
  }

  const priorityKey = deepDive?.priority ?? "low"
  const pBadge = SEVERITY_BADGES[priorityKey] ?? SEVERITY_BADGES.low

  return (
    <Card className="border border-border/80 bg-card/70 shadow-xs overflow-hidden">
      {/* Top Header */}
      <CardHeader className="border-b border-border/70 bg-muted/20 py-2.5 px-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SlidersIcon className="size-4 text-primary" />
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-foreground">
              LLM Deep-Dive Analysis
            </CardTitle>
            {isAutoTriggered && triggerLLM && (
              <Badge variant="outline" className="text-[10px] font-mono border-amber-500/40 text-amber-400 bg-amber-500/10">
                HS &lt; 70
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="sm" className="size-7 p-0" />}>
                <HelpCircleIcon className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                Tổng hợp tình trạng viễn trắc, phân tích nguyên nhân và đề xuất can thiệp.
              </TooltipContent>
            </Tooltip>

            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={exportJSON}
            >
              <DownloadIcon className="size-3" />
              <span>Xuất JSON</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="size-7 p-0"
              onClick={triggerDeepDive}
              disabled={isLoading}
            >
              <RefreshCwIcon className={cn("size-3", isLoading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3.5 space-y-3.5">
        {isLoading && !deepDive ? (
          <LoadingSkeleton />
        ) : deepDive ? (
          <>
            {/* 1. Thanh Chỉ số Kỹ thuật Nhanh (Executive KPI Strip) */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 rounded-lg border border-border/80 bg-background/70 p-2.5 text-xs font-mono">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted-foreground uppercase font-sans">Mức độ rủi ro</span>
                <Badge variant="outline" className={cn("w-fit text-[10px] py-0 px-2 font-mono", pBadge.className)}>
                  {pBadge.label.split(" ")[0]}
                </Badge>
              </div>

              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted-foreground uppercase font-sans">Điểm sức khỏe (HS)</span>
                <span className="font-bold text-foreground text-sm leading-tight">{score} / 100</span>
              </div>

              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted-foreground uppercase font-sans">Độ tin cậy AI</span>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-primary text-sm leading-tight">
                    {Math.round(deepDive.confidence * 100)}%
                  </span>
                  <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${Math.round(deepDive.confidence * 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted-foreground uppercase font-sans">Bất thường phát hiện</span>
                <span className="font-bold text-foreground text-sm leading-tight">{anomalies.length} sự kiện</span>
              </div>
            </div>

            {/* Diagnostic Summary Note */}
            <div className="rounded border border-border/70 bg-muted/20 px-3 py-1.5 text-xs font-mono text-muted-foreground flex items-center justify-between">
              <span>{deepDive.summary}</span>
              <span className="text-[10px] font-sans text-muted-foreground">Tự động đối chiếu ngưỡng</span>
            </div>

            {/* 2. Bảng Phân tích Kỹ thuật & Sự cố Cụ thể (Engineering Incident Table) */}
            <div className="grid gap-3.5 lg:grid-cols-12">
              {/* Cột trái (7 cols): Danh sách Sự cố & Nguyên nhân kỹ thuật */}
              <div className="lg:col-span-7 rounded-lg border border-border/80 bg-background/50 p-3 space-y-2.5">
                <div className="flex items-center justify-between border-b border-border/60 pb-1.5">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <ActivityIcon className="size-3.5 text-primary" />
                    <span>Chi tiết Sự cố & Phân tích Nguyên nhân</span>
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground">Top {Math.min(anomalies.length, 4)}</span>
                </div>

                {anomalies.length > 0 ? (
                  <div className="divide-y divide-border/40">
                    {anomalies.slice(0, 4).map((a) => {
                      const isHigh = a.severity === "critical" || a.severity === "high"
                      return (
                        <div
                          key={a.id}
                          onClick={() => onSelectAnomaly?.(a.id)}
                          className="py-2 flex items-center justify-between gap-2 hover:bg-muted/30 px-1.5 rounded transition-colors cursor-pointer group"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={cn(
                                "size-2 rounded-full shrink-0",
                                a.severity === "critical" ? "bg-red-500"
                                : a.severity === "high" ? "bg-orange-500"
                                : a.severity === "medium" ? "bg-yellow-500"
                                : "bg-emerald-500"
                              )}
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs font-semibold text-foreground truncate">
                                  {a.title}
                                </span>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "font-mono text-[9px] px-1 py-0 uppercase",
                                    isHigh ? "border-orange-500/40 text-orange-400" : "border-border text-muted-foreground"
                                  )}
                                >
                                  {a.severity}
                                </Badge>
                              </div>
                              <div className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
                                Kênh: {a.topics.join(", ") || "Hệ thống"} · Conf: {Math.round((a.confidence ?? 0.8) * 100)}%
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 text-[11px] text-primary group-hover:translate-x-0.5 transition-transform shrink-0 font-medium">
                            <span>Chi tiết</span>
                            <ChevronRightIcon className="size-3.5" />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="py-4 text-center text-xs text-muted-foreground font-mono">
                    Không ghi nhận sự cố bất thường
                  </div>
                )}
              </div>

              {/* Cột phải (5 cols): Quy trình Can thiệp Kỹ thuật & Điều hướng */}
              <div className="lg:col-span-5 rounded-lg border border-border/80 bg-background/50 p-3 flex flex-col justify-between space-y-2.5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between border-b border-border/60 pb-1.5">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <CheckCircle2Icon className="size-3.5 text-emerald-400" />
                      <span>Quy trình Can thiệp Kỹ thuật</span>
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">SOP</span>
                  </div>

                  <div className="space-y-1.5">
                    {deepDive.suggestions.map((suggestion, i) => (
                      <div
                        key={i}
                        className="rounded border border-border/60 bg-muted/20 p-2 text-xs flex items-start gap-2"
                      >
                        <span className="font-mono font-bold text-muted-foreground text-[10px] rounded bg-background px-1 py-0.5 border border-border/50 shrink-0">
                          {i + 1}
                        </span>
                        <span className="text-foreground text-[11px] leading-snug font-medium">
                          {suggestion}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Direct Action Link */}
                <div className="pt-2 border-t border-border/40">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (anomalies[0]?.id) {
                        onSelectAnomaly?.(anomalies[0].id)
                      }
                      const el = document.getElementById("analysis-timeline-section")
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth" })
                      }
                    }}
                    className="w-full h-8 gap-2 text-xs font-medium text-foreground hover:bg-accent cursor-pointer shadow-xs"
                  >
                    <span>Mở Timeline & Duyệt lỗi bên dưới</span>
                    <ArrowRightIcon className="size-3.5 text-primary" />
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center p-4 text-center">
            <SlidersIcon className="size-8 text-muted-foreground mb-2 opacity-50" />
            <p className="text-xs text-muted-foreground">
              Nhấp để tạo báo cáo chẩn đoán kỹ thuật cho toàn bộ phiên vận hành
            </p>
            <Button
              className="mt-2.5 h-7.5 gap-1.5 text-xs font-medium cursor-pointer"
              size="sm"
              onClick={triggerDeepDive}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <LoaderIcon className="size-3 animate-spin" />
                  <span>Đang tổng hợp...</span>
                </>
              ) : (
                <>
                  <SlidersIcon className="size-3" />
                  <span>Kích hoạt LLM Deep-Dive</span>
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
