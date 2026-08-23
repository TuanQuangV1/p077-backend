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

function getTopicStatus(topic: TopicStat): { status: "critical" | "warning" | "healthy" | "silent"; label: string } {
  const dropPct = (topic.dropRate ?? 0) * 100
  const actualHz = topic.hz ?? 0
  const expectedHz = topic.expectedHz ?? 0

  // Static / latched topics (expectedHz === 0, e.g. /tf_static) are normal in ROS2
  if (topic.name.includes("static") || (expectedHz === 0 && actualHz === 0)) {
    return { status: "healthy", label: "ỔN ĐỊNH" }
  }

  // Active topic that died / silent node
  if (actualHz === 0 && expectedHz > 0) {
    return { status: "silent", label: "MẤT TÍN HIỆU" }
  }

  if (dropPct >= 50) {
    return { status: "critical", label: "NGHIÊM TRỌNG" }
  }
  if (dropPct >= 30 || (expectedHz > 0 && actualHz < expectedHz * 0.7)) {
    return { status: "warning", label: "CẢNH BÁO" }
  }
  return { status: "healthy", label: "ỔN ĐỊNH" }
}

function getTopicDetections(topicName: string, anomalies: Anomaly[]): Anomaly[] {
  // A topic's detections are the ones recorded against it. The kind checks that
  // used to sit here were OR'd with the topic test, so a single rate drop was
  // attributed to every topic in the table at once — and they named demo-only
  // kinds, so real backend detections matched neither branch.
  return anomalies.filter((a) => a.topics.includes(topicName))
}

export function TopicHealthTable({
  topics,
  anomalies,
  onSelectAnomaly,
}: TopicHealthTableProps) {
  const [filter, setFilter] = useState<FilterType>("all")
  const [expandedTopic, setExpandedTopic] = useState<string | null>(null)

  const filteredTopics = topics.filter((topic) => {
    const { status } = getTopicStatus(topic)
    if (filter === "all") return true
    if (filter === "critical") return status === "critical"
    if (filter === "warning") return status === "warning"
    if (filter === "healthy") return status === "healthy"
    if (filter === "silent") return status === "silent"
    return true
  })

  const counts = {
    all: topics.length,
    critical: topics.filter((t) => getTopicStatus(t).status === "critical").length,
    warning: topics.filter((t) => getTopicStatus(t).status === "warning").length,
    healthy: topics.filter((t) => getTopicStatus(t).status === "healthy").length,
    silent: topics.filter((t) => getTopicStatus(t).status === "silent").length,
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <SignalIcon className="size-4" />
            Sức khỏe Cảm biến (Topic Health)
          </CardTitle>
          <div className="flex items-center gap-1">
            {(["all", "critical", "warning", "healthy", "silent"] as FilterType[]).map(
              (f) => (
                <Button
                  key={f}
                  variant={filter === f ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "Tất cả" : f === "critical" ? "Nghiêm trọng" : f === "warning" ? "Cảnh báo" : f === "healthy" ? "Bình thường" : "Im lặng"}
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
                  Chủ đề (Topic)
                </th>
                <th className="px-2 py-2 text-right font-mono text-[10px] uppercase text-muted-foreground">
                  Hz Kỳ vọng
                </th>
                <th className="px-2 py-2 text-right font-mono text-[10px] uppercase text-muted-foreground">
                  Thực tế
                </th>
                <th className="px-2 py-2 text-right font-mono text-[10px] uppercase text-muted-foreground">
                  Tỷ lệ giảm
                </th>
                <th className="px-2 py-2 text-center font-mono text-[10px] uppercase text-muted-foreground">
                  Trạng thái
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredTopics.map((topic) => {
                const { status, label } = getTopicStatus(topic)
                const dropPct = Math.round(topic.dropRate * 100)
                const color = STATUS_COLORS[status]
                const topicDetections = getTopicDetections(topic.name, anomalies)
                const isExpanded = expandedTopic === topic.name

                return (
                  // A Fragment, not Collapsible: that primitive renders a <div>,
                  // which is invalid directly inside <tbody> and breaks hydration.
                  // Expansion is already driven by `expandedTopic` state.
                  <Fragment key={topic.name}>
                    <tr className="group">
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setExpandedTopic(isExpanded ? null : topic.name)}
                          className="flex items-center gap-1.5 text-left hover:text-primary"
                        >
                          {isExpanded ? (
                            <ChevronDownIcon className="size-3" />
                          ) : (
                            <ChevronRightIcon className="size-3" />
                          )}
                          <span className="font-mono">{topic.name}</span>
                        </button>
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-muted-foreground">
                        {topic.expectedHz}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        <span
                          style={{
                            color: status !== "healthy" ? color : undefined,
                          }}
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
                          className="text-[10px]"
                          style={{
                            borderColor: color,
                            color,
                            backgroundColor: `${color}10`,
                          }}
                        >
                          {label}
                        </Badge>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="bg-muted/30">
                        <td colSpan={5} className="px-4 py-2">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="text-muted-foreground">
                                {topic.messageCount.toLocaleString()} tin nhắn (messages)
                              </span>
                              <span className="font-mono text-muted-foreground">
                                {topic.messageType}
                              </span>
                            </div>
                            {topicDetections.length > 0 ? (
                              <div className="space-y-1">
                                <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                                  Sự cố phát hiện ({topicDetections.length})
                                </span>
                                {topicDetections.map((det) => (
                                  <button
                                    key={det.id}
                                    onClick={() => onSelectAnomaly?.(det.id)}
                                    className="flex w-full items-center gap-2 rounded border border-border bg-card px-2 py-1 text-left transition-colors hover:bg-accent"
                                  >
                                    <span
                                      className="size-1.5 shrink-0 rounded-full"
                                      style={{
                                        backgroundColor:
                                          STATUS_COLORS[det.severity],
                                      }}
                                    />
                                    <span className="flex-1 truncate text-[10px]">
                                      {det.title}
                                    </span>
                                    <Badge
                                      variant="outline"
                                      className="text-[9px]"
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
                                Không phát hiện sự cố nào trên topic này
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
          {filteredTopics.length === 0 && (
            <p className="p-4 text-center text-sm text-muted-foreground">
              Không có topic nào phù hợp với bộ lọc đã chọn
            </p>
          )}
        </div>
        <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          Tổng cộng: {filteredTopics.length} topics
          {counts.critical > 0 && (
            <span className="ml-2 font-semibold" style={{ color: STATUS_COLORS.critical }}>
              | {counts.critical} Nghiêm trọng
            </span>
          )}
          {counts.warning > 0 && (
            <span className="ml-2 font-semibold" style={{ color: STATUS_COLORS.medium }}>
              | {counts.warning} Cảnh báo
            </span>
          )}
          {counts.healthy > 0 && (
            <span className="ml-2 font-semibold" style={{ color: STATUS_COLORS.healthy }}>
              | {counts.healthy} Đạt chuẩn
            </span>
          )}
          {counts.silent > 0 && (
            <span className="ml-2 font-semibold" style={{ color: STATUS_COLORS.silent }}>
              | {counts.silent} Mất tín hiệu
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
