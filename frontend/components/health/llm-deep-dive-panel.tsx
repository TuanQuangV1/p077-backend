"use client"

import { useEffect, useState } from "react"
import { BotIcon, BrainCircuitIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon, HelpCircleIcon, LoaderIcon, RefreshCwIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Anomaly, HealthSummary, LLMDeepDiveResult, Severity } from "@/lib/types"

/**
 * Deterministic fallback used while the deep-dive endpoint isn't wired to a
 * live LLM: same heuristic the mock server used, computed client-side from
 * data already on hand (no network round trip, no response-shape to drift).
 */
function generateFallbackAnalysis(healthScore: number, anomalies: Anomaly[]): LLMDeepDiveResult {
  if (anomalies.length === 0) {
    return {
      summary: "Không phát hiện bất thường. Hệ thống hoạt động bình thường.",
      explanation: [
        "Tất cả chỉ số telemetry trong ngưỡng bình thường",
        "Tần số topic ổn định và trong ngưỡng kỳ vọng",
      ],
      suggestions: [
        "Tiếp tục theo dõi trong phiên vận hành tiếp theo",
        "Cân nhắc kiểm tra sức khỏe định kỳ mỗi 24 giờ",
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
    explanations.push(`${severityCounts.critical} bất thường nghiêm trọng cần chú ý ngay`)
    suggestions.push("Cô lập hệ thống bị ảnh hưởng và chẩn đoán khẩn cấp")
    suggestions.push("Rà soát thay đổi cấu hình hoặc cập nhật phần mềm gần đây")
    components.push("system_critical")
  }
  if (severityCounts.high > 0) {
    explanations.push(`${severityCounts.high} bất thường mức cao có thể ảnh hưởng độ tin cậy`)
    suggestions.push("Lên lịch cửa sổ bảo trì để điều tra")
    suggestions.push("Theo dõi chặt chẽ nguy cơ leo thang lên nghiêm trọng")
    if (!components.includes("system_critical")) components.push("diagnostics")
  }

  const topicCounts = new Map<string, number>()
  for (const a of anomalies) {
    for (const topic of a.topics) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
  }
  const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (topTopics.length > 0) {
    explanations.push(`Chủ đề bị ảnh hưởng nhiều nhất: ${topTopics.map(([t]) => t).join(", ")}`)
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
    summary: `Điểm sức khỏe ${healthScore}/100: ${severityCounts.critical + severityCounts.high} vấn đề nghiêm trọng/cao, ${severityCounts.medium + severityCounts.low} vấn đề trung bình/thấp`,
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

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#6c757d",
}

const PRIORITY_LABELS: Record<string, string> = {
  critical: "NGHIÊM TRỌNG",
  high: "CAO",
  medium: "TRUNG BÌNH",
  low: "THẤP",
}

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#6c757d",
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const el = document.createElement("textarea")
        el.value = text
        el.style.position = "fixed"
        el.style.opacity = "0"
        document.body.appendChild(el)
        el.select()
        document.execCommand("copy")
        document.body.removeChild(el)
      }
      setCopied(true)
      toast.success("Đã sao chép vào clipboard")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Không thể sao chép vào clipboard")
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={copy}>
      {copied ? <CheckCircleIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </Button>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <LoaderIcon className="size-4 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">Đang phân tích dữ liệu sức khỏe...</span>
      </div>
      <div className="space-y-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}

function EmptyState({ score }: { score: number }) {
  return (
    <div className="flex flex-col items-center justify-center p-6 text-center">
      <CheckCircleIcon className="size-12 text-green-500 mb-3" />
      <h3 className="text-lg font-semibold">Hệ thống khỏe mạnh</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Điểm sức khỏe {score}/100 - không phát hiện vấn đề nghiêm trọng.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Tiếp tục theo dõi để bảo trì chủ động.
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
  const status = health?.status ?? "green"
  const triggerLLM = health?.trigger_llm_deep_dive ?? false

  // Auto-trigger deep-dive when health score drops below threshold
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
    a.download = `health-analysis-${runLabel}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 0)
    toast.success("Đã xuất phân tích sức khỏe")
  }

  if (!health) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BrainCircuitIcon className="size-4" />
            Phân tích chuyên sâu LLM
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
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BrainCircuitIcon className="size-4" />
            Phân tích chuyên sâu LLM
            <Badge variant="outline" className="ml-auto text-[10px]">
              Tự động
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState score={score} />
        </CardContent>
      </Card>
    )
  }

  const priorityColor = deepDive ? PRIORITY_COLORS[deepDive.priority] : "#6c757d"

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BrainCircuitIcon className="size-4" />
            Phân tích chuyên sâu LLM
            {isAutoTriggered && triggerLLM && (
              <Badge variant="outline" className="text-[10px]">
                Tự động kích hoạt (HS &lt; 70)
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="sm" className="size-8 p-0" />}>
                <HelpCircleIcon className="size-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs text-xs">
                LLM phân tích dữ liệu sức khỏe để xác định nguyên nhân gốc và đề xuất khắc phục.
                Tự động kích hoạt khi điểm sức khỏe dưới 70.
              </TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0"
              onClick={exportJSON}
            >
              <DownloadIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0"
              onClick={triggerDeepDive}
              disabled={isLoading}
            >
              <RefreshCwIcon className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading && !deepDive ? (
          <LoadingSkeleton />
        ) : deepDive ? (
          <>
            {/* Executive Summary */}
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: `${priorityColor}30`,
                backgroundColor: `${priorityColor}05`,
              }}
            >
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Tóm tắt điều hành
                </h4>
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs font-medium"
                    style={{ color: priorityColor }}
                  >
                    Độ tin cậy {Math.round(deepDive.confidence * 100)}%
                  </span>
                  <span className="text-muted-foreground">|</span>
                  <Badge
                    variant="outline"
                    className="text-[10px]"
                    style={{
                      borderColor: priorityColor,
                      color: priorityColor,
                    }}
                  >
                    {PRIORITY_LABELS[deepDive.priority] ?? deepDive.priority.toUpperCase()}
                  </Badge>
                </div>
              </div>
              <p className="mt-2 text-sm">{deepDive.summary}</p>
            </div>

            {/* Root Cause Analysis */}
            {deepDive.explanation.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Phân tích nguyên nhân gốc rễ
                </h4>
                <ul className="mt-2 space-y-1.5">
                  {deepDive.explanation.map((exp, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                      <span>{exp}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Affected Components */}
            {deepDive.affected_components.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Thành phần bị ảnh hưởng
                </h4>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {deepDive.affected_components.map((comp) => (
                    <Badge
                      key={comp}
                      variant="secondary"
                      className="font-mono text-[10px]"
                    >
                      {comp}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Recommended Fixes */}
            {deepDive.suggestions.length > 0 && (
              <div>
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Đề xuất hướng khắc phục
                  </h4>
                </div>
                <div className="mt-2 space-y-2">
                  {deepDive.suggestions.map((suggestion, i) => (
                    <Collapsible key={i}>
                      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:bg-accent">
                        <CheckCircleIcon className="size-4 shrink-0 text-green-500" />
                        <span className="flex-1 text-sm">{suggestion}</span>
                        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform ui-open:rotate-180" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                          Kiểm tra tệp cấu hình liên quan và tham số ROS2.
                          Tham khảo tài liệu Nav2 cho thực hành tốt nhất.
                        </p>
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              </div>
            )}

            {/* Phát hiện liên quan */}
            {anomalies.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Phát hiện liên quan
                </h4>
                <div className="mt-2 space-y-1">
                  {anomalies.slice(0, 5).map((anomaly) => (
                    <button
                      key={anomaly.id}
                      onClick={() => onSelectAnomaly?.(anomaly.id)}
                      className="flex w-full items-center gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: SEVERITY_COLORS[anomaly.severity] }}
                      />
                      <span className="flex-1 truncate text-xs">{anomaly.title}</span>
                      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center">
            <BotIcon className="size-12 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              Nhấn để phân tích dữ liệu sức khỏe với LLM
            </p>
            <Button
              className="mt-3"
              size="sm"
              onClick={triggerDeepDive}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <LoaderIcon className="mr-2 size-4 animate-spin" />
                  Đang phân tích...
                </>
              ) : (
                <>
                  <BrainCircuitIcon className="mr-2 size-4" />
                  Hỏi LLM
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
