"use client"

import { useEffect, useState } from "react"
import { AlertCircleIcon, LoaderIcon } from "lucide-react"

import { LLMDeepDivePanel } from "@/components/health/llm-deep-dive-panel"
import { TopicHealthTable } from "@/components/health/topic-health-table"
import { TFTreeStatus } from "@/components/health/tf-tree-status"
import { LatencyJitterPanel } from "@/components/health/latency-jitter-panel"
import { DataBandwidthPanel } from "@/components/health/data-bandwidth-panel"
import { TimelineDensityHeatmap } from "@/components/health/timeline-density-heatmap"
import { HealthBadge, HealthScoreHeroCard, OperationalMetricsRibbon } from "@/components/health/health-gauge"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { ChevronDownIcon } from "lucide-react"
import { fetcher } from "@/lib/api"
import { filterByGroup, ungrouped } from "@/lib/anomaly-groups"
import type { Anomaly, HealthSummary, LatencyWindow, LogEvent, Rosbag, TopicStat } from "@/lib/types"

interface AnalysisHealthPanelProps {
  activeRunId: string | null
  rosbag: Rosbag | null
  anomalies: Anomaly[]
  logs: LogEvent[]
  /** Per-topic stats derived from the run's window export; falls back to the
   *  dataset's own topic list, which is empty for bags uploaded without metadata. */
  topics?: TopicStat[]
  /** Transport-timing slices from the run's window export, one per time bucket.
   *  Empty when the run has no window data yet. */
  latencyWindows?: LatencyWindow[]
  onSelectAnomaly?: (id: string) => void
  onSeek?: (tSec: number) => void
}

export function AnalysisHealthPanel({
  activeRunId,
  rosbag,
  anomalies,
  logs,
  topics: topicsProp,
  latencyWindows = [],
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

    let cancelled = false
    setIsLoading(true)
    fetcher<{ health: HealthSummary } | HealthSummary>(`/api/runs/${activeRunId}/health`)
      .then((res) => {
        if (!cancelled) setHealth("health" in res ? res.health : res)
      })
      .catch((err) => {
        if (cancelled) return
        console.error("Failed to fetch health:", err)
        setHealth(null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
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
    <div className="space-y-4">
      {/* 1. Dedicated Hero Health Assessment Card */}
      <HealthScoreHeroCard
        health={health}
        durationSec={durationSec}
        anomaliesCount={anomalies.length}
      />

      {/* 2. Dedicated Operational Telemetry & Transport Metrics Card Frame */}
      <OperationalMetricsRibbon
        rosbag={rosbag}
        topics={topics}
        anomalies={anomalies}
        logs={logs}
        health={health}
      />

      {/* 3. Detailed Subsystems Diagnostic Collapsible */}
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <Card>
          <button onClick={() => setIsExpanded(!isExpanded)} className="w-full text-left cursor-pointer">
            <CardHeader className="hover:bg-accent/50 transition-colors py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                    Detailed Telemetry & Subsystems Diagnostics
                  </CardTitle>
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
            <CardContent className="space-y-4 pt-1">
              {/* Row 1: Spatial TF Tree & Temporal Heatmap (2 Balanced 50/50 Columns) */}
              <div className="grid gap-4 lg:grid-cols-2 items-stretch">
                <TFTreeStatus
                  tfAnomalies={tfAnomalies}
                  onSelectAnomaly={onSelectAnomaly}
                />

                <TimelineDensityHeatmap
                  anomalies={anomalies}
                  durationSec={durationSec}
                  onSelectAnomaly={onSelectAnomaly}
                  onRangeSelect={(from: number, _to: number) => onSeek?.(from)}
                />
              </div>

              {/* Row 2: Sensor Topic Cadence & QoS Health Table (Full Width for unlimited topics) */}
              <TopicHealthTable
                topics={topics}
                anomalies={anomalies}
                onSelectAnomaly={onSelectAnomaly}
              />

              {/* Row 3: Transport Latency & Bandwidth Throughput (Spacious 50/50 Columns) */}
              <div className="grid gap-4 lg:grid-cols-2 items-stretch">
                <LatencyJitterPanel
                  windows={latencyWindows}
                  latencyAnomalies={latencyAnomalies}
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
  </div>
)
}
