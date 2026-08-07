"use client"

import { useEffect, useState } from "react"
import { AlertCircleIcon, LoaderIcon } from "lucide-react"

import { HealthGauge, HealthScoreCard } from "@/components/health/health-gauge"
import { LLMDeepDivePanel } from "@/components/health/llm-deep-dive-panel"
import { TopicHealthTable } from "@/components/health/topic-health-table"
import { LogSeverityPanel } from "@/components/health/log-severity-panel"
import { TFTreeStatus } from "@/components/health/tf-tree-status"
import { LatencyJitterPanel } from "@/components/health/latency-jitter-panel"
import { DataBandwidthPanel } from "@/components/health/data-bandwidth-panel"
import { TimelineDensityHeatmap } from "@/components/health/timeline-density-heatmap"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { ChevronDownIcon } from "lucide-react"
import { fetcher } from "@/lib/api"
import type { Anomaly, HealthSummary, LogEvent, Rosbag, TopicStat } from "@/lib/types"

interface AnalysisHealthPanelProps {
  activeRunId: string | null
  rosbag: Rosbag | null
  anomalies: Anomaly[]
  logs: LogEvent[]
  onSelectAnomaly?: (id: string) => void
  onSeek?: (tSec: number) => void
}

export function AnalysisHealthPanel({
  activeRunId,
  rosbag,
  anomalies,
  logs,
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

    setIsLoading(true)
    fetcher<{ health: HealthSummary } | HealthSummary>(`/api/runs/${activeRunId}/health`)
      .then((res) => setHealth("health" in res ? res.health : res))
      .catch((err) => {
        console.error("Failed to fetch health:", err)
        setHealth(null)
      })
      .finally(() => setIsLoading(false))
  }, [activeRunId])

  // Group anomalies by type
  const tfAnomalies = anomalies.filter(
    (a) =>
      a.kind === "tf_timeout" ||
      a.kind === "localization_jump",
  )
  const logAnomalies = anomalies.filter(
    (a) =>
      a.kind === "tf_timeout" ||
      a.kind === "cpu_spike" ||
      a.kind === "nav_recovery",
  )
  const latencyAnomalies = anomalies.filter(
    (a) =>
      a.kind === "header_latency" ||
      a.kind === "timestamp_jitter",
  )
  const payloadAnomalies = anomalies.filter(
    (a) => a.kind === "message_drop",
  )
  const frequencyAnomalies = anomalies.filter(
    (a) =>
      a.kind === "topic_hz_drop" ||
      a.kind === "lidar_dropout",
  )

  // Find worst drop topic
  const topics: TopicStat[] = rosbag?.topics ?? []
  let worstDrop = { topic: null as string | null, pct: 0 }
  for (const t of topics) {
    const dropPct = Math.round(t.dropRate * 100)
    if (dropPct > worstDrop.pct) {
      worstDrop = { topic: t.name, pct: dropPct }
    }
  }

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
            {/* KPI Cards Row */}
            <HealthScoreCard
              score={health.health_score}
              status={health.status}
              worstSeverity={health.summary?.worst_severity ?? null}
              topDropPct={worstDrop.pct}
              topDropTopic={worstDrop.topic}
              duration={durationSec}
              messageCount={rosbag?.messageCount ?? 0}
            />

            {/* Main Grid */}
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Left Column */}
              <div className="space-y-4">
                {/* Health Gauge + TF Tree */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex justify-center">
                    <HealthGauge
                      score={health.health_score}
                      status={health.status}
                      size="md"
                    />
                  </div>
                  <TFTreeStatus
                    tfAnomalies={tfAnomalies}
                    onSelectAnomaly={onSelectAnomaly}
                  />
                </div>

                {/* Topic Health Table */}
                <TopicHealthTable
                  topics={topics}
                  anomalies={anomalies}
                  onSelectAnomaly={onSelectAnomaly}
                />

                {/* Latency + Data Bandwidth */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <LatencyJitterPanel
                    latencyAnomalies={latencyAnomalies}
                    durationSec={durationSec}
                  />
                  <DataBandwidthPanel
                    topics={topics}
                    payloadAnomalies={payloadAnomalies}
                  />
                </div>
              </div>

              {/* Right Column */}
              <div className="space-y-4">
                {/* Log Severity */}
                <LogSeverityPanel
                  logs={logs}
                  anomalies={logAnomalies}
                />

                {/* Timeline Heatmap */}
                <TimelineDensityHeatmap
                  anomalies={anomalies}
                  durationSec={durationSec}
                  onSelectAnomaly={onSelectAnomaly}
                  onRangeSelect={(from, to) => onSeek?.(from)}
                />

                {/* Group Scores Summary */}
                <GroupScoresSummary health={health} />
              </div>
            </div>

            {/* LLM Deep-Dive Panel */}
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
      <span>HS {score}</span>
      <span className="text-muted-foreground">|</span>
      <span>
        {status === "green" ? "HEALTHY"
          : status === "yellow" ? "DEGRADED"
          : "INCIDENT"}
      </span>
    </div>
  )
}

function GroupScoresSummary({ health }: { health: HealthSummary }) {
  const groups = [
    { key: "frequency", label: "Frequency", icon: "Hz" },
    { key: "tf", label: "TF Tree", icon: "TF" },
    { key: "log", label: "Log", icon: "LOG" },
    { key: "latency", label: "Latency", icon: "LAT" },
    { key: "payload", label: "Payload", icon: "PLD" },
  ]

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Group Scores</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {groups.map((g) => {
            const data = health.summary.groups[g.key]
            if (!data) return null
            const score = data.score
            const color =
              score >= 80 ? "#28a745"
              : score >= 60 ? "#ffc107"
              : "#dc3545"

            return (
              <div key={g.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px]">
                      {g.icon}
                    </span>
                    {g.label}
                  </span>
                  <span className="font-mono tabular-nums" style={{ color }}>
                    {score.toFixed(1)}/100
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${score}%`,
                      backgroundColor: color,
                    }}
                  />
                </div>
                <div className="flex justify-between text-[9px] text-muted-foreground">
                  <span>{data.detection_count} detections</span>
                  <span>weight: {data.weight}</span>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
