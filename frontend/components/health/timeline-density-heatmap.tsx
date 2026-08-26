"use client"

import { useState } from "react"
import {
  ActivityIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClockIcon,
  ExternalLinkIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Anomaly, Severity } from "@/lib/types"
import { relativeSpan } from "@/lib/anomaly-groups"
import { formatDuration } from "@/lib/health-engine"

interface TimelineDensityHeatmapProps {
  anomalies: Anomaly[]
  durationSec: number
  onSelectAnomaly?: (id: string) => void
  onRangeSelect?: (from: number, to: number) => void
}

interface HeatmapBucket {
  index: number
  start: number
  end: number
  density: number
  severity: "none" | "low" | "medium" | "high" | "critical"
  anomalyIds: string[]
}

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#6c757d",
}

const BUCKET_SIZE_SEC = 10 // 10 second buckets

function buildBuckets(anomalies: Anomaly[], durationSec: number): HeatmapBucket[] {
  const safeDuration = durationSec > 0 ? durationSec : 1
  const bucketCount = Math.max(1, Math.ceil(safeDuration / BUCKET_SIZE_SEC))
  const buckets: HeatmapBucket[] = []

  for (let i = 0; i < bucketCount; i++) {
    const start = i * BUCKET_SIZE_SEC
    const end = Math.min((i + 1) * BUCKET_SIZE_SEC, safeDuration)

    // Find anomalies in this bucket
    const bucketAnomalies = anomalies.filter((a) => {
      const span = relativeSpan(a)
      return (
        (span.start >= start && span.start < end) ||
        (span.end > start && span.end <= end) ||
        (span.start <= start && span.end >= end)
      )
    })

    // Determine highest severity level
    let maxSeverity: HeatmapBucket["severity"] = "none"
    if (bucketAnomalies.length > 0) {
      const severities = bucketAnomalies.map((a) => a.severity)
      if (severities.includes("critical")) maxSeverity = "critical"
      else if (severities.includes("high")) maxSeverity = "high"
      else if (severities.includes("medium")) maxSeverity = "medium"
      else if (severities.includes("low")) maxSeverity = "low"
    }

    buckets.push({
      index: i,
      start,
      end,
      density: bucketAnomalies.length,
      severity: maxSeverity,
      anomalyIds: bucketAnomalies.map((a) => a.id),
    })
  }

  return buckets
}

export function TimelineDensityHeatmap({
  anomalies,
  durationSec,
  onSelectAnomaly,
  onRangeSelect,
}: TimelineDensityHeatmapProps) {
  const [hoveredBucket, setHoveredBucket] = useState<HeatmapBucket | null>(null)
  const [selectedAnomaly, setSelectedAnomaly] = useState<Anomaly | null>(null)

  const safeDuration = durationSec > 0 ? durationSec : 1
  const buckets = buildBuckets(anomalies, safeDuration)

  const handleBucketClick = (bucket: HeatmapBucket) => {
    onRangeSelect?.(bucket.start, bucket.end)
  }

  const handleAnomalyClick = (anomaly: Anomaly) => {
    setSelectedAnomaly(anomaly)
    onSelectAnomaly?.(anomaly.id)
    onRangeSelect?.(relativeSpan(anomaly).start, relativeSpan(anomaly).end)
  }

  // Generate 5 ruler points
  const rulerTicks = [0, 0.25, 0.5, 0.75, 1].map((pct) => {
    const sec = Math.round(safeDuration * pct)
    return {
      pct: pct * 100,
      sec,
      label: formatDuration(sec),
    }
  })

  return (
    <Card className="border border-border/70 bg-card/60">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-cyan-400" />
            <CardTitle className="text-sm font-semibold tracking-wide">
              DÒNG THỜI GIAN PHÁT HIỆN SỰ CỐ
            </CardTitle>
            <Badge variant="outline" className="text-[10px] font-mono">
              {anomalies.length} sự cố ghi nhận
            </Badge>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-[#dc3545]" />
              <span>Nghiêm trọng</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-[#fd7e14]" />
              <span>Cao</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-[#ffc107]" />
              <span>Cảnh báo</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-emerald-500/30 border border-emerald-500/50" />
              <span>Bình thường</span>
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Visual Timeline Track Bar */}
        <div className="relative rounded-xl border border-border/60 bg-muted/20 p-3 pt-2">
          {/* Time Ruler Labels & Ticks */}
          <div className="relative mb-2 h-5 w-full">
            {rulerTicks.map((tick, i) => (
              <div
                key={i}
                className="absolute flex -translate-x-1/2 flex-col items-center"
                style={{ left: `${tick.pct}%` }}
              >
                <span className="font-mono text-[10px] font-medium text-muted-foreground">
                  {tick.label} ({tick.sec}s)
                </span>
                <div className="h-1.5 w-px bg-border" />
              </div>
            ))}
          </div>

          {/* Continuous Multi-slot Heatmap Track */}
          <div className="relative flex h-11 w-full overflow-hidden rounded-lg border border-border/50 bg-background/80 shadow-inner">
            {buckets.map((bucket, i) => {
              const hasAnomaly = bucket.density > 0
              const color =
                bucket.severity === "critical"
                  ? "#dc3545"
                  : bucket.severity === "high"
                  ? "#fd7e14"
                  : bucket.severity === "medium"
                  ? "#ffc107"
                  : bucket.severity === "low"
                  ? "#6c757d"
                  : "transparent"

              return (
                <button
                  key={i}
                  onClick={() => handleBucketClick(bucket)}
                  onMouseEnter={() => setHoveredBucket(bucket)}
                  onMouseLeave={() => setHoveredBucket(null)}
                  className={`
                    group relative flex-1 border-r border-border/20 transition-all
                    hover:z-10 hover:brightness-125
                    ${hasAnomaly ? "cursor-pointer" : "cursor-default hover:bg-muted/30"}
                  `}
                  style={{
                    backgroundColor: hasAnomaly ? `${color}25` : undefined,
                  }}
                  title={`t=${bucket.start}s - ${bucket.end}s: ${
                    hasAnomaly
                      ? `${bucket.density} sự cố (${bucket.severity})`
                      : "Hoạt động bình thường"
                  }`}
                >
                  {/* Active Incident Block Bar */}
                  {hasAnomaly ? (
                    <div
                      className="absolute inset-x-0.5 bottom-0 top-0 rounded flex items-center justify-center transition-transform group-hover:scale-y-105"
                      style={{
                        backgroundColor: color,
                        boxShadow: `0 0 8px ${color}80`,
                      }}
                    >
                      <span className="text-[9px] font-bold text-white drop-shadow">
                        !
                      </span>
                    </div>
                  ) : (
                    // Subtle Healthy Pulse Line
                    <div className="absolute inset-x-0 bottom-1/2 h-0.5 bg-emerald-500/20" />
                  )}
                </button>
              )
            })}
          </div>

          {/* Hover Tooltip */}
          {hoveredBucket && (
            <div className="mt-2 flex items-center justify-between rounded-lg border border-border/70 bg-popover/90 px-3 py-1.5 text-xs shadow-md backdrop-blur">
              <div className="flex items-center gap-2">
                <ClockIcon className="size-3.5 text-muted-foreground" />
                <span className="font-mono font-semibold text-foreground">
                  Khoảng thời gian: {hoveredBucket.start}s ➔ {hoveredBucket.end}s
                </span>
              </div>
              <div>
                {hoveredBucket.density > 0 ? (
                  <span
                    className="font-semibold uppercase"
                    style={{
                      color:
                        hoveredBucket.severity === "critical"
                          ? "#dc3545"
                          : hoveredBucket.severity === "high"
                          ? "#fd7e14"
                          : "#ffc107",
                    }}
                  >
                    Phát hiện {hoveredBucket.density} sự cố ({hoveredBucket.severity})
                  </span>
                ) : (
                  <span className="text-emerald-400 font-medium">
                    ✓ Hoạt động bình thường (0 sự cố)
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Detections List */}
        {anomalies.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Danh sách sự cố phát hiện ({anomalies.length})
              </span>
              <span className="text-[11px] text-muted-foreground">
                Nhấp vào từng sự cố để xem chi tiết & nhảy tới mốc thời gian
              </span>
            </div>

            <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
              {anomalies.map((anomaly) => {
                const color = SEVERITY_COLORS[anomaly.severity]
                const isSelected = selectedAnomaly?.id === anomaly.id
                const startSec = relativeSpan(anomaly).start

                return (
                  <button
                    key={anomaly.id}
                    onClick={() => handleAnomalyClick(anomaly)}
                    className={`
                      flex w-full items-center justify-between rounded-lg border p-2.5 text-left
                      transition-all
                      ${
                        isSelected
                          ? "border-primary bg-accent/80 shadow-sm"
                          : "border-border/60 bg-card/40 hover:border-border hover:bg-accent/40"
                      }
                    `}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold"
                        style={{
                          backgroundColor: `${color}20`,
                          color: color,
                          border: `1px solid ${color}50`,
                        }}
                      >
                        !
                      </span>

                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-foreground">
                            t = {startSec.toFixed(1)}s ({formatDuration(startSec)})
                          </span>
                          <span className="text-xs font-medium text-foreground">
                            {anomaly.title}
                          </span>
                        </div>
                        {anomaly.metric && (
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            Chi tiết: {anomaly.metric}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px] uppercase"
                        style={{
                          borderColor: `${color}60`,
                          color: color,
                          backgroundColor: `${color}10`,
                        }}
                      >
                        {anomaly.kind}
                      </Badge>
                      <ChevronRightIcon className="size-4 text-muted-foreground" />
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 py-6 text-center">
            <CheckCircle2Icon className="size-6 text-emerald-400" />
            <div className="text-sm font-semibold text-emerald-400">
              Không phát hiện sự cố nào trong suốt phiên ghi
            </div>
            <div className="text-xs text-muted-foreground">
              Toàn bộ {safeDuration} giây dữ liệu hoạt động ổn định và đúng tần số thiết kế.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
