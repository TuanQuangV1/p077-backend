"use client"

import { useEffect, useState } from "react"
import { AlertCircleIcon, LoaderIcon } from "lucide-react"

import { HealthGauge, HealthScoreCard } from "@/components/health/health-gauge"
import { LLMDeepDivePanel } from "@/components/health/llm-deep-dive-panel"
import { TopicHealthTable } from "@/components/health/topic-health-table"
import { TFTreeStatus } from "@/components/health/tf-tree-status"
import { LatencyJitterPanel } from "@/components/health/latency-jitter-panel"
import { DataBandwidthPanel } from "@/components/health/data-bandwidth-panel"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { ChevronDownIcon } from "lucide-react"
import { fetcher } from "@/lib/api"
import { filterByGroup, ungrouped } from "@/lib/anomaly-groups"
import { computeSystemMetrics } from "@/lib/health-engine"
import type { Anomaly, HealthSummary, LogEvent, Rosbag, TopicStat } from "@/lib/types"

interface AnalysisHealthPanelProps {
  activeRunId: string | null
  rosbag: Rosbag | null
  anomalies: Anomaly[]
  logs: LogEvent[]
  /** Per-topic stats derived from the run's window export; falls back to the
   *  dataset's own topic list, which is empty for bags uploaded without metadata. */
  topics?: TopicStat[]
  onSelectAnomaly?: (id: string) => void
  onSeek?: (tSec: number) => void
}

export function AnalysisHealthPanel({
  activeRunId,
  rosbag,
  anomalies,
  logs,
  topics: topicsProp,
  onSelectAnomaly,
  onSeek,
}: AnalysisHealthPanelProps) {
  const [health, setHealth] = useState<HealthSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isExpanded, setIsExpanded] = useState(true)

  // Fetch health summary
  useEffect(() => {
    if (!activeRunId) {
      setHealth(null)
      setIsLoading(false)
      return
    }

    let isMounted = true
    setIsLoading(true)

    fetcher<{ health?: HealthSummary } & HealthSummary>(`/api/v1/analysis/${activeRunId}/health`)
      .then((data) => {
        if (isMounted) {
          setHealth(data.health ?? data)
          setIsLoading(false)
        }
      })
      .catch((err) => {
        console.error("Failed to fetch health summary:", err)
        if (isMounted) {
          setHealth(null)
          setIsLoading(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [activeRunId])

  // Topics: prop > fallback to empty
  const topics = topicsProp ?? []

  // Group anomalies by domain
  const tfAnomalies = filterByGroup("transform", anomalies)
  const latencyAnomalies = filterByGroup("timing", anomalies)
  const payloadAnomalies = filterByGroup("payload", anomalies)
  const otherAnomalies = ungrouped(anomalies)

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            <span className="text-sm">Loading health data...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!health) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-muted-foreground">
            <AlertCircleIcon className="size-4" />
            <span className="text-sm">No health data available</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  const durationSec = rosbag?.durationSec ?? 120

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <Card>
        <button onClick={() => setIsExpanded(!isExpanded)} className="w-full">
        <CardHeader className="cursor-pointer hover:bg-accent/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CardTitle className="text-sm">
                  Health Analysis
                </CardTitle>
                <HealthBadge score={health.health_score} status={health.status} />
                {health.trigger_llm_deep_dive && (
                  <Badge
                    variant="outline"
                    className="text-[10px]"
                    style={{
                      borderColor: "#ffc107",
                      color: "#ffc107",
                    }}
                  >
                    LLM Analysis Available
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                {otherAnomalies.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    {otherAnomalies.length} unmapped
                  </Badge>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {anomalies.length} detections
                </span>
                <ChevronDownIcon
                  className={`size-4 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
                />
              </div>
            </div>
          </CardHeader>
        </button>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            {/* Row 1: 5 KPI Cards */}
            {(() => {
              const systemMetrics = computeSystemMetrics({
                rosbag,
                topics,
                anomalies,
                logs,
                health,
              })
              return <HealthScoreCard metrics={systemMetrics} />
            })()}

            {/* Row 2: 3 High-Level Overview Cards (Harmonious Executive Row) */}
            <div className="grid gap-4 md:grid-cols-3">
              {/* Card 1: Health Gauge */}
              <Card className="flex flex-col border border-border/70 bg-card/60">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold tracking-wide">
                    Điểm Sức khỏe Tổng quan
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-1 items-center justify-center py-4">
                  <HealthGauge
                    score={health.health_score}
                    status={health.status}
                    size="md"
                  />
                </CardContent>
              </Card>

              {/* Card 2: TF Tree Status */}
              <TFTreeStatus
                tfAnomalies={tfAnomalies}
                onSelectAnomaly={onSelectAnomaly}
              />

              {/* Card 3: Group Scores Summary */}
              <GroupScoresSummary health={health} />
            </div>

            {/* Row 3: Sức khỏe Cảm biến (Topic Health) - Nguyên 1 hàng ngang full width */}
            <div className="w-full">
              <TopicHealthTable
                topics={topics}
                anomalies={anomalies}
                onSelectAnomaly={onSelectAnomaly}
              />
            </div>

            {/* Row 4: Độ trễ & Băng thông (Latency & Bandwidth) - 2 cột nằm ngang song song 50/50 */}
            <div className="grid gap-4 md:grid-cols-2">
              <LatencyJitterPanel
                latencyAnomalies={latencyAnomalies}
                durationSec={durationSec}
              />
              <DataBandwidthPanel
                topics={topics}
                payloadAnomalies={payloadAnomalies}
              />
            </div>

            {/* Row 4: LLM Deep-Dive Panel */}
            <LLMDeepDivePanel
              health={health}
              activeRunId={activeRunId}
              anomalies={anomalies}
              onSelectAnomaly={onSelectAnomaly}
            />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

function HealthBadge({ score, status }: { score: number; status: string }) {
  const color =
    status === "green" ? "#28a745"
    : status === "yellow" ? "#ffc107"
    : "#dc3545"

  const label =
    status === "green" ? "TỐT"
    : status === "yellow" ? "SUY GIẢM"
    : "NGHIÊM TRỌNG"

  const scoreVal = typeof score === "number" && !isNaN(score) ? Math.round(score) : (status === "green" ? 100 : 70)

  return (
    <div
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold"
      style={{
        borderColor: `${color}40`,
        backgroundColor: `${color}10`,
        color,
      }}
    >
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span>HS {scoreVal} | {label}</span>
    </div>
  )
}

function GroupScoresSummary({ health }: { health: HealthSummary }) {
  const groups = health?.summary?.groups ?? {}

  const groupLabels: Record<string, { label: string; icon: string }> = {
    frequency: { label: "Tần số (Frequency)", icon: "Hz" },
    tf: { label: "Cây Tọa độ (TF Tree)", icon: "TF" },
    log: { label: "Nhật ký (Log)", icon: "LOG" },
    latency: { label: "Độ trễ (Latency)", icon: "LAT" },
    payload: { label: "Dung lượng (Payload)", icon: "PLD" },
  }

  return (
    <Card className="flex flex-col border border-border/70 bg-card/60">
      <CardHeader className="py-2.5 px-3.5">
        <CardTitle className="text-xs font-semibold">
          Phân bố Điểm Nhóm (Group Scores)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 py-2 px-3.5">
        {Object.entries(groups).map(([key, data]) => {
          const info = groupLabels[key] || { label: key, icon: key }
          const score = data.score
          const color =
            score >= 80 ? "bg-ok"
            : score >= 60 ? "bg-warn"
            : "bg-danger"

          return (
            <div key={key} className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <span className="font-mono text-[9px] font-semibold text-primary">
                    {info.icon}
                  </span>
                  <span>{info.label}</span>
                </span>
                <span className="font-mono font-medium">{score.toFixed(1)}/100</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full transition-all ${color}`}
                  style={{ width: `${score}%` }}
                />
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
