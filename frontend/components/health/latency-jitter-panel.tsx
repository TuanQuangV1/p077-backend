"use client"

import { useState } from "react"
import { ClockIcon, ActivityIcon, AlertTriangleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Anomaly } from "@/lib/types"
import { isKindIn, relativeSpan } from "@/lib/anomaly-groups"

interface LatencyJitterPanelProps {
  latencyAnomalies: Anomaly[]
  durationSec: number
}

type ViewMode = "latency" | "jitter" | "clock"

const THRESHOLD_MS = 100

function LatencyBarChart({ data, threshold }: { data: number[]; threshold: number }) {
  const maxVal = Math.max(...data, threshold)
  const height = 80

  return (
    <div className="relative h-[80px] border-b border-border">
      {/* Threshold line */}
      <div
        className="absolute left-0 right-0 border-t-2 border-dashed border-red-400"
        style={{
          bottom: `${(threshold / maxVal) * height}px`,
        }}
      >
        <span className="absolute -top-4 right-0 text-[9px] text-red-400">
          {threshold}ms
        </span>
      </div>

      {/* Bars */}
      <div className="flex h-full items-end gap-px">
        {data.map((val, i) => {
          const barHeight = (val / maxVal) * height
          const isHigh = val > threshold
          return (
            <div
              key={i}
              className="flex-1 transition-colors"
              style={{
                height: `${Math.max(2, barHeight)}px`,
                backgroundColor: isHigh ? "#dc3545" : "#28a745",
                opacity: isHigh ? 0.9 : 0.5,
              }}
              title={`${val.toFixed(1)}ms`}
            />
          )
        })}
      </div>
    </div>
  )
}

function generateMockData(
  mode: ViewMode,
  durationSec: number,
  anomalies: Anomaly[],
): number[] {
  const buckets = 60
  const data: number[] = []

  for (let i = 0; i < buckets; i++) {
    const tSec = (i / buckets) * durationSec

    // Base latency varies by mode
    let base =
      mode === "latency"
        ? 15 + Math.sin(i * 0.2) * 10
        : mode === "jitter"
        ? 5 + Math.sin(i * 0.3) * 3
        : 10 + Math.sin(i * 0.15) * 5

    // Add some noise
    base += Math.random() * 10 - 5

    // Check if there's an anomaly in this time range
    const affectedAnomaly = anomalies.find((a) => isKindIn("timing", a.kind))
    const span = affectedAnomaly ? relativeSpan(affectedAnomaly) : null
    if (span && tSec >= span.start && tSec <= span.end) {
      base += 80 + Math.random() * 40
    }

    data.push(Math.max(0, base))
  }

  return data
}

const MODE_LABELS: Record<ViewMode, string> = {
  latency: "Độ trễ Header (Latency)",
  jitter: "Biến động (Jitter)",
  clock: "Trôi đồng hồ (Clock Drift)",
}

const MODE_HELP: Record<ViewMode, string> = {
  latency: "Thời gian giữa header.stamp và thời điểm xuất bản (publish time)",
  jitter: "Độ lệch chuẩn khoảng cách giữa các tin nhắn liên tiếp",
  clock: "Độ lệch timestamp trung vị giữa |bag - header|",
}

export function LatencyJitterPanel({
  latencyAnomalies,
  durationSec,
}: LatencyJitterPanelProps) {
  const [mode, setMode] = useState<ViewMode>("latency")

  const data = generateMockData(mode, durationSec, latencyAnomalies)
  const highCount = data.filter((v) => v > THRESHOLD_MS).length
  const maxVal = Math.max(...data)
  const avgVal = data.reduce((a, b) => a + b, 0) / data.length

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClockIcon className="size-4" />
            Độ trễ & Biến động (Latency & Jitter)
          </CardTitle>
        </div>
        {/* Mode toggle */}
        <div className="mt-2 flex gap-1">
          {(["latency", "jitter", "clock"] as ViewMode[]).map((m) => (
            <Button
              key={m}
              variant={mode === m ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[10px]"
              onClick={() => setMode(m)}
            >
              {MODE_LABELS[m]}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Chart */}
        <LatencyBarChart data={data} threshold={THRESHOLD_MS} />

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <span className="text-lg font-bold tabular-nums">
              {maxVal.toFixed(0)}
            </span>
            <span className="text-xs text-muted-foreground">ms tối đa</span>
          </div>
          <div>
            <span className="text-lg font-bold tabular-nums">
              {avgVal.toFixed(0)}
            </span>
            <span className="text-xs text-muted-foreground">ms trung bình</span>
          </div>
          <div>
            <span
              className={`text-lg font-bold tabular-nums ${highCount > 0 ? "text-red-500" : ""}`}
            >
              {highCount}
            </span>
            <span className="text-xs text-muted-foreground">
              {">"}{THRESHOLD_MS}ms
            </span>
          </div>
        </div>

        {/* Mode description */}
        <p className="text-[10px] text-muted-foreground">
          {MODE_HELP[mode]}
        </p>

        {/* Anomaly alert */}
        {latencyAnomalies.length > 0 && (
          <div className="flex items-center gap-2 rounded border border-border bg-card p-2">
            <AlertTriangleIcon className="size-4 text-yellow-500" />
            <div className="flex-1">
              <p className="text-xs font-medium">
                Phát hiện {latencyAnomalies.length} bất thường độ trễ
              </p>
              <p className="text-[10px] text-muted-foreground">
                Trễ duy trì tại t={latencyAnomalies[0] ? relativeSpan(latencyAnomalies[0]).start.toFixed(0) : "?"}s
              </p>
            </div>
            <Badge
              variant="outline"
              className="text-[9px]"
              style={{
                borderColor: "#ffc107",
                color: "#ffc107",
              }}
            >
              {latencyAnomalies[0]?.kind}
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
