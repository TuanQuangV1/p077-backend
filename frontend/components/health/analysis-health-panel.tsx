"use client"

import { useEffect, useState } from "react"
import { AlertCircleIcon, LoaderIcon } from "lucide-react"

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
import { filterByGroup, ungrouped } from "@/lib/anomaly-groups"
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
  const tfAnomalies = filterByGroup("transform", anomalies)
  const logAnomalies = filterByGroup("logs", anomalies)
  const latencyAnomalies = filterByGroup("timing", anomalies)
  const payloadAnomalies = filterByGroup("payload", anomalies)
  const otherAnomalies = ungrouped(anomalies)

  const topics: TopicStat[] = topicsProp?.length ? topicsProp : (rosbag?.topics ?? [])

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-muted-foreground font-mono text-sm">
            <LoaderIcon className="size-4 animate-spin text-primary" />
            <span>Loading telemetry health scores...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!health) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-muted-foreground font-mono text-sm">
            <AlertCircleIcon className="size-4" />
            <span>No health summary recorded for this run</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  const durationSec = rosbag?.durationSec ?? 120

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <Card>
        <button onClick={() => setIsExpanded(!isExpanded)} className="w-full text-left cursor-pointer">
          <CardHeader className="hover:bg-accent/50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CardTitle className="text-sm font-semibold">
                  Subsystem Health & Telemetry Diagnostics
                </CardTitle>
                <HealthBadge score={health.health_score} status={health.status} />
                {health.trigger_llm_deep_dive && (
                  <Badge
                    variant="outline"
                    className="text-[10px] font-mono"
                    style={{
                      borderColor: "#ffc107",
                      color: "#ffc107",
                    }}
                  >
                    LLM Synthesis Available
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                {otherAnomalies.length > 0 && (
                  <Badge variant="outline" className="text-[10px] font-mono">
                    {otherAnomalies.length} unclassified
                  </Badge>
                )}
                <span className="text-[10px] text-muted-foreground font-mono">
                  {anomalies.length} anomalies
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
            {/* Main Grid */}
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Left Column */}
              <div className="space-y-4">
                <TFTreeStatus
                  tfAnomalies={tfAnomalies}
                  onSelectAnomaly={onSelectAnomaly}
                />

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
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold font-mono"
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
      <span>HEALTH {score}</span>
      <span className="text-muted-foreground">|</span>
      <span>
        {status === "green" ? "NOMINAL"
          : status === "yellow" ? "DEGRADED"
          : "CRITICAL"}
      </span>
    </div>
  )
}

function GroupScoresSummary({ health }: { health: HealthSummary }) {
  const groups = [
    { key: "frequency", label: "Topic Cadence", icon: "Hz" },
    { key: "tf", label: "TF2 Tree", icon: "TF" },
    { key: "log", label: "ROS Logs", icon: "LOG" },
    { key: "latency", label: "Transport Latency", icon: "LAT" },
    { key: "payload", label: "Payload Throughput", icon: "PLD" },
  ]

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Diagnostic Subsystem Scores</CardTitle>
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
                  <span className="font-mono tabular-nums font-semibold" style={{ color }}>
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
                <div className="flex justify-between text-[9px] text-muted-foreground font-mono">
                  <span>{data.detection_count} anomalies</span>
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
