"use client"

import { Fragment, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, SignalIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Anomaly, TopicStat } from "@/lib/types"

interface TopicHealthTableProps {
  topics: TopicStat[]
  anomalies: Anomaly[]
  onSelectAnomaly?: (id: string) => void
}

type FilterType = "all" | "critical" | "warning" | "healthy" | "silent"

const STATUS_COLORS: Record<string, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#6c757d",
  healthy: "#28a745",
  silent: "#6c757d",
  warning: "#ffc107",
}

// Topics that must never appear in the Hz health table — they are
// event-driven / latched and have no stable publish cadence. Keeping
// them here produced false Critical (e.g. /tf_static 0/0) and
// polluted the sensor view. Covered by dedicated panels (logs, TF tree).
const HZ_EXCLUDED_TOPIC_NAMES = new Set<string>([
  "/tf_static",
  "/diagnostics",
  "/rosout",
  "/plan",
  "/local_costmap/costmap",
])

const HZ_EXCLUDED_MESSAGE_TYPES = new Set<string>([
  "diagnostic_msgs/msg/DiagnosticArray",
  "rcl_interfaces/msg/Log",
  "nav_msgs/msg/Path",
  "nav_msgs/msg/OccupancyGrid",
])

// Severity rank for sorting: critical/silent first, then warning, then healthy.
// Within the same rank, the larger drop comes first.
const STATUS_RANK: Record<string, number> = {
  critical: 3,
  silent: 3,
  warning: 2,
  healthy: 1,
}

/** Sensor-health relevance — mirrors `src/services/diagnostics.py:cadence_topics` + latched rule. */
function isHzRelevant(topic: TopicStat): boolean {
  if (HZ_EXCLUDED_TOPIC_NAMES.has(topic.name)) return false
  if (HZ_EXCLUDED_MESSAGE_TYPES.has(topic.messageType)) {
    if (topic.messageType === "nav_msgs/msg/OccupancyGrid" && topic.name !== "/local_costmap/costmap") {
      // fall through — keep it
    } else {
      return false
    }
  }
  if (topic.messageType === "geometry_msgs/msg/PoseWithCovarianceStamped" || topic.name === "/amcl_pose") {
    return topic.dropRate >= 0.5
  }
  return true
}

function getTopicStatus(topic: TopicStat): { status: "critical" | "warning" | "healthy" | "silent"; label: string } {
  const dropPct = topic.dropRate * 100
  const actualHz = topic.hz
  const expectedHz = topic.expectedHz

  if (actualHz === 0 && expectedHz > 0) {
    return { status: "silent", label: "SILENT" }
  }
  if (actualHz === 0 || dropPct >= 50) {
    return { status: "critical", label: "CRITICAL" }
  }
  if (dropPct >= 30 || actualHz < expectedHz * 0.7) {
    return { status: "warning", label: "DEGRADED" }
  }
  return { status: "healthy", label: "NOMINAL" }
}

function getTopicDetections(topicName: string, anomalies: Anomaly[]): Anomaly[] {
  return anomalies.filter((a) => a.topics.includes(topicName))
}

export function TopicHealthTable({
  topics,
  anomalies,
  onSelectAnomaly,
}: TopicHealthTableProps) {
  const [filter, setFilter] = useState<FilterType>("all")
  const [expandedTopic, setExpandedTopic] = useState<string | null>(null)

  const relevantTopics = topics.filter(isHzRelevant)

  const filteredTopics = relevantTopics.filter((topic) => {
    const { status } = getTopicStatus(topic)
    if (filter === "all") return true
    if (filter === "critical") return status === "critical"
    if (filter === "warning") return status === "warning"
    if (filter === "healthy") return status === "healthy"
    if (filter === "silent") return status === "silent"
    return true
  })

  const sortedTopics = [...filteredTopics].sort((a, b) => {
    const rankA = STATUS_RANK[getTopicStatus(a).status] ?? 0
    const rankB = STATUS_RANK[getTopicStatus(b).status] ?? 0
    if (rankB !== rankA) return rankB - rankA
    if (b.dropRate !== a.dropRate) return b.dropRate - a.dropRate
    return a.name.localeCompare(b.name)
  })

  const counts = {
    all: relevantTopics.length,
    critical: relevantTopics.filter((t) => getTopicStatus(t).status === "critical").length,
    warning: relevantTopics.filter((t) => getTopicStatus(t).status === "warning").length,
    healthy: relevantTopics.filter((t) => getTopicStatus(t).status === "healthy").length,
    silent: relevantTopics.filter((t) => getTopicStatus(t).status === "silent").length,
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <SignalIcon className="size-4" />
            Sensor Topic Cadence & QoS Health
          </CardTitle>
          <div className="flex items-center gap-1">
            {(["all", "critical", "warning", "healthy", "silent"] as FilterType[]).map(
              (f) => (
                <Button
                  key={f}
                  variant={filter === f ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2 text-[10px] cursor-pointer"
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "All" : f === "critical" ? "Critical" : f === "warning" ? "Degraded" : f === "healthy" ? "Nominal" : "Silent"}
                  <span className="ml-1 font-mono">{counts[f]}</span>
                </Button>
              ),
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-mono text-[10px] uppercase text-muted-foreground">
                  ROS2 Topic
                </th>
                <th className="px-2 py-2 text-right font-mono text-[10px] uppercase text-muted-foreground">
                  Expected Hz
                </th>
                <th className="px-2 py-2 text-right font-mono text-[10px] uppercase text-muted-foreground">
                  Observed Hz
                </th>
                <th className="px-2 py-2 text-right font-mono text-[10px] uppercase text-muted-foreground">
                  Hz Drop
                </th>
                <th className="px-2 py-2 text-center font-mono text-[10px] uppercase text-muted-foreground">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {sortedTopics.map((topic) => {
                const { status, label } = getTopicStatus(topic)
                const dropPct = Math.round(topic.dropRate * 100)
                const color = STATUS_COLORS[status]
                const topicDetections = getTopicDetections(topic.name, anomalies)
                const isExpanded = expandedTopic === topic.name

                return (
                  <Fragment key={topic.name}>
                    <tr
                      onClick={() => {
                        if (topicDetections.length > 0) {
                          onSelectAnomaly?.(topicDetections[0].id)
                        } else {
                          setExpandedTopic(isExpanded ? null : topic.name)
                        }
                      }}
                      className={`group hover:bg-accent/40 transition-colors cursor-pointer ${
                        topicDetections.length > 0 ? "hover:border-primary/50" : ""
                      }`}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5 text-left">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setExpandedTopic(isExpanded ? null : topic.name)
                            }}
                            className="p-0.5 hover:bg-muted rounded"
                          >
                            {isExpanded ? (
                              <ChevronDownIcon className="size-3" />
                            ) : (
                              <ChevronRightIcon className="size-3" />
                            )}
                          </button>
                          <span className="font-mono text-xs text-foreground font-medium group-hover:text-primary transition-colors">
                            {topic.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-muted-foreground">
                        {topic.expectedHz}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        <span
                          style={{
                            color: status !== "healthy" ? color : undefined,
                          }}
                          className="font-semibold"
                        >
                          {topic.hz}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        {dropPct > 0 ? (
                          <span
                            style={{
                              color:
                                dropPct > 50
                                  ? STATUS_COLORS.critical
                                  : dropPct > 30
                                  ? STATUS_COLORS.medium
                                  : "inherit",
                            }}
                            className="font-semibold"
                          >
                            -{dropPct}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0%</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase font-bold"
                          style={{
                            borderColor: color,
                            color,
                            backgroundColor: `${color}10`,
                          }}
                          title={
                            topicDetections.length > 0
                              ? `Click to sync timeline to ${topicDetections[0].title}`
                              : undefined
                          }
                        >
                          {label}
                          {topicDetections.length > 0 && (
                            <span className="ml-1 text-[8.5px] opacity-75">🎯</span>
                          )}
                        </Badge>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="bg-muted/30">
                        <td colSpan={5} className="px-4 py-2 font-sans">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="text-muted-foreground">
                                {topic.messageCount.toLocaleString()} total messages
                              </span>
                              <span className="font-mono text-muted-foreground">
                                {topic.messageType}
                              </span>
                            </div>
                            {topicDetections.length > 0 ? (
                              <div className="space-y-1">
                                <span className="text-[10px] font-semibold uppercase text-muted-foreground font-mono">
                                  Correlated Fault Detections
                                </span>
                                {topicDetections.map((det) => (
                                  <button
                                    key={det.id}
                                    onClick={() => onSelectAnomaly?.(det.id)}
                                    className="flex w-full items-center gap-2 rounded border border-border bg-card px-2 py-1 text-left transition-colors hover:bg-accent cursor-pointer"
                                  >
                                    <span
                                      className="size-1.5 shrink-0 rounded-full"
                                      style={{
                                        backgroundColor:
                                          STATUS_COLORS[det.severity],
                                      }}
                                    />
                                    <span className="flex-1 truncate text-[10px] font-medium">
                                      {det.title}
                                    </span>
                                    <Badge
                                      variant="outline"
                                      className="text-[9px] font-mono"
                                      style={{
                                        borderColor: STATUS_COLORS[det.severity],
                                        color: STATUS_COLORS[det.severity],
                                      }}
                                    >
                                      {det.kind}
                                    </Badge>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="text-[10px] text-muted-foreground">
                                No anomalies attributed to this sensor topic
                              </p>
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          {sortedTopics.length === 0 && (
            <p className="p-4 text-center text-sm text-muted-foreground font-sans">
              No topics match the selected filter criteria.
            </p>
          )}
        </div>
        <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground font-mono">
          Summary: {sortedTopics.length} topics
          {counts.critical > 0 && (
            <span className="ml-2" style={{ color: STATUS_COLORS.critical }}>
              | {counts.critical} Critical
            </span>
          )}
          {counts.warning > 0 && (
            <span className="ml-2" style={{ color: STATUS_COLORS.medium }}>
              | {counts.warning} Degraded
            </span>
          )}
          {counts.healthy > 0 && (
            <span className="ml-2" style={{ color: STATUS_COLORS.healthy }}>
              | {counts.healthy} Nominal
            </span>
          )}
          {counts.silent > 0 && (
            <span className="ml-2" style={{ color: STATUS_COLORS.silent }}>
              | {counts.silent} Silent
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
