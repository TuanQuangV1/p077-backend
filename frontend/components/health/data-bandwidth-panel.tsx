"use client"

import { useState } from "react"
import { HardDriveIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Anomaly, TopicStat } from "@/lib/types"

interface DataBandwidthPanelProps {
  topics: TopicStat[]
  payloadAnomalies: Anomaly[]
}

interface TopicBandwidth {
  name: string
  avgBytes: number
  peakBytes: number
  zeroCount: number
  percentage: number
  status: "healthy" | "warning" | "zero"
}

function TopicBubbleCard({
  topic,
  isSelected,
  onClick,
}: {
  topic: TopicBandwidth
  isSelected: boolean
  onClick: () => void
}) {
  const statusColor =
    topic.status === "zero"
      ? "#dc3545"
      : topic.status === "warning"
      ? "#ffc107"
      : "#28a745"

  const statusLabel =
    topic.status === "zero"
      ? "EMPTY"
      : topic.status === "warning"
      ? "WARNING"
      : "NOMINAL"

  // Size based on percentage
  const size = Math.max(60, Math.min(100, topic.percentage * 1.5))

  return (
    <button
      onClick={onClick}
      className={`
        flex flex-col items-center justify-center rounded-lg border p-3
        transition-colors
        ${isSelected ? "ring-2 ring-primary" : ""}
        hover:bg-accent cursor-pointer
      `}
      style={{
        borderColor: `${statusColor}40`,
        backgroundColor: `${statusColor}08`,
        minWidth: size,
        minHeight: size,
      }}
    >
      <span className="truncate max-w-full font-mono text-[10px] text-foreground">
        {topic.name.replace("/", "")}
      </span>
      <span className="text-lg font-bold tabular-nums font-mono" style={{ color: statusColor }}>
        {topic.status === "zero" ? "0 B" : formatBytes(topic.avgBytes)}
      </span>
      <Badge
        variant="outline"
        className="mt-1 text-[9px] font-mono uppercase"
        style={{
          borderColor: statusColor,
          color: statusColor,
        }}
      >
        {statusLabel}
      </Badge>
      {topic.zeroCount > 0 && (
        <span className="mt-0.5 text-[9px] text-muted-foreground font-mono">
          {topic.zeroCount}x zero-byte
        </span>
      )}
    </button>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function SimpleDoughnut({
  data,
}: {
  data: Array<{ label: string; value: number; color: string }>
}) {
  const total = data.reduce((a, b) => a + b.value, 0)
  let currentAngle = -90 // Start at top

  const paths = data.map((item) => {
    const angle = (item.value / total) * 360
    const startAngle = currentAngle
    const endAngle = currentAngle + angle
    currentAngle = endAngle

    const startRad = (startAngle * Math.PI) / 180
    const endRad = (endAngle * Math.PI) / 180

    const x1 = 50 + 40 * Math.cos(startRad)
    const y1 = 50 + 40 * Math.sin(startRad)
    const x2 = 50 + 40 * Math.cos(endRad)
    const y2 = 50 + 40 * Math.sin(endRad)

    const largeArc = angle > 180 ? 1 : 0

    const path = `M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArc} 1 ${x2} ${y2} Z`

    return { path, color: item.color, label: item.label, percentage: Math.round((item.value / total) * 100) }
  })

  return (
    <div className="flex flex-col items-center gap-3">
      <svg width="120" height="120" viewBox="0 0 100 100" className="transform -rotate-90">
        {paths.map((p, i) => (
          <path key={i} d={p.path} fill={p.color} />
        ))}
        <circle cx="50" cy="50" r="25" fill="var(--background)" />
      </svg>
      <div className="flex flex-wrap justify-center gap-2">
        {data.map((item, i) => (
          <div key={i} className="flex items-center gap-1 text-[10px] font-mono">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-muted-foreground">
              {item.label.replace("/", "")} {Math.round((item.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function DataBandwidthPanel({
  topics,
  payloadAnomalies,
}: DataBandwidthPanelProps) {
  const [viewMode, setViewMode] = useState<"bubbles" | "doughnut">("bubbles")

  const totalMessages = topics.reduce((a, b) => a + b.messageCount, 0)

  const topicBandwidth: TopicBandwidth[] = topics.map((topic) => {
    const hasZeroPayload = payloadAnomalies.some((a) => a.topics.includes(topic.name))

    const percentage = totalMessages > 0
      ? (topic.messageCount / totalMessages) * 100
      : 0

    return {
      name: topic.name,
      avgBytes: Math.round(topic.messageCount * 100),
      peakBytes: Math.round(topic.messageCount * 150),
      zeroCount: hasZeroPayload ? Math.round(topic.messageCount * 0.02) : 0,
      percentage,
      status: hasZeroPayload ? "zero" : topic.dropRate > 0.3 ? "warning" : "healthy",
    }
  })

  topicBandwidth.sort((a, b) => b.percentage - a.percentage)

  const doughnutData = topicBandwidth.slice(0, 6).map((topic) => ({
    label: topic.name,
    value: topic.percentage,
    color:
      topic.status === "zero"
        ? "#dc3545"
        : topic.status === "warning"
        ? "#ffc107"
        : ["#3b82f6", "#8b5cf6", "#ec4899", "#f97316", "#22c55e", "#06b6d4"][
            topicBandwidth.indexOf(topic) % 6
          ],
  }))

  const totalZeroCount = topicBandwidth.reduce((a, b) => a + b.zeroCount, 0)
  const hasAnomaly = payloadAnomalies.length > 0 || totalZeroCount > 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <HardDriveIcon className="size-4" />
            Topic Bandwidth & Payload Throughput
          </CardTitle>
          <div className="flex gap-1">
            <Button
              variant={viewMode === "bubbles" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[10px] cursor-pointer"
              onClick={() => setViewMode("bubbles")}
            >
              Bubbles
            </Button>
            <Button
              variant={viewMode === "doughnut" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[10px] cursor-pointer"
              onClick={() => setViewMode("doughnut")}
            >
              Donut
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {viewMode === "bubbles" ? (
          <div className="flex flex-wrap justify-center gap-2 py-4">
            {topicBandwidth.slice(0, 8).map((topic) => (
              <TopicBubbleCard
                key={topic.name}
                topic={topic}
                isSelected={false}
                onClick={() => {}}
              />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center py-4">
            <SimpleDoughnut data={doughnutData} />
          </div>
        )}

        {/* Anomaly alert */}
        {hasAnomaly && (
          <div className="mt-3 flex items-center gap-2 rounded border border-red-200 bg-red-50 p-2 dark:border-red-900 dark:bg-red-950">
            <span className="size-2 rounded-full bg-red-500" />
            <div className="flex-1">
              <p className="text-xs font-medium text-red-600 dark:text-red-400">
                {payloadAnomalies.length > 0
                  ? `${payloadAnomalies.length} payload throughput anomalies`
                  : `${totalZeroCount} zero-byte empty messages`}
              </p>
            </div>
            <Badge
              variant="outline"
              className="text-[9px] font-mono"
              style={{
                borderColor: "#dc3545",
                color: "#dc3545",
              }}
            >
              PLD-01
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
