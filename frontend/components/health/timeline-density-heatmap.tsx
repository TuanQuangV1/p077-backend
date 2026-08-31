"use client"

import { useState } from "react"
import { AlertCircleIcon, ChevronRightIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Anomaly, Severity } from "@/lib/types"
import { relativeSpan } from "@/lib/anomaly-groups"

interface TimelineDensityHeatmapProps {
  anomalies: Anomaly[]
  durationSec: number
  onSelectAnomaly?: (id: string) => void
  onRangeSelect?: (from: number, to: number) => void
}

interface HeatmapBucket {
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

const SEVERITY_LABEL: Record<string, string> = {
  critical: "nghiêm trọng",
  high: "cao",
  medium: "trung bình",
  low: "thấp",
  none: "không có",
}

const BUCKET_SIZE_SEC = 10 // 10 second buckets

function buildBuckets(anomalies: Anomaly[], durationSec: number): HeatmapBucket[] {
  const bucketCount = Math.ceil(durationSec / BUCKET_SIZE_SEC)
  const buckets: HeatmapBucket[] = []

  for (let i = 0; i < bucketCount; i++) {
    const start = i * BUCKET_SIZE_SEC
    const end = Math.min((i + 1) * BUCKET_SIZE_SEC, durationSec)

    // Find anomalies in this bucket
    const bucketAnomalies = anomalies.filter(
      (a) => relativeSpan(a).start >= start && relativeSpan(a).start < end,
    )

    // Determine severity level
    let maxSeverity: HeatmapBucket["severity"] = "none"
    if (bucketAnomalies.length > 0) {
      const severities = bucketAnomalies.map((a) => a.severity)
      if (severities.includes("critical")) maxSeverity = "critical"
      else if (severities.includes("high")) maxSeverity = "high"
      else if (severities.includes("medium")) maxSeverity = "medium"
      else if (severities.includes("low")) maxSeverity = "low"
    }

    buckets.push({
      start,
      end,
      density: bucketAnomalies.length,
      severity: maxSeverity,
      anomalyIds: bucketAnomalies.map((a) => a.id),
    })
  }

  return buckets
}

function getBucketColor(
  severity: HeatmapBucket["severity"],
  density: number,
): string {
  switch (severity) {
    case "critical":
      return "#dc3545"
    case "high":
      return "#fd7e14"
    case "medium":
      return "#ffc107"
    case "low":
      return "#6c757d"
    default:
      // Scale from light to dark based on density
      const opacity = Math.min(0.3, density * 0.1)
      return `rgba(107, 114, 128, ${opacity})`
  }
}

export function TimelineDensityHeatmap({
  anomalies,
  durationSec,
  onSelectAnomaly,
  onRangeSelect,
}: TimelineDensityHeatmapProps) {
  const [hoveredBucket, setHoveredBucket] = useState<HeatmapBucket | null>(null)
  const [selectedAnomaly, setSelectedAnomaly] = useState<Anomaly | null>(null)

  const buckets = buildBuckets(anomalies, durationSec)

  // Timeline markers for anomalies
  const anomalyMarkers = anomalies
    .filter((a) => a.severity === "critical" || a.severity === "high")
    .slice(0, 10)

  const handleBucketClick = (bucket: HeatmapBucket) => {
    if (bucket.anomalyIds.length > 0) {
      onRangeSelect?.(bucket.start, bucket.end)
    }
  }

  const handleAnomalyClick = (anomaly: Anomaly) => {
    setSelectedAnomaly(anomaly)
    onSelectAnomaly?.(anomaly.id)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            Dòng thời gian phát hiện
          </CardTitle>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-[#dc3545]" /> Nghiêm trọng
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-[#fd7e14]" /> Cao
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-[#ffc107]" /> Trung bình
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-[#6c757d]" /> Thấp
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Heatmap */}
        <div className="relative">
          {/* Time axis */}
          <div className="mb-1 flex justify-between font-mono text-[9px] text-muted-foreground">
            <span>0s</span>
            <span>{Math.floor(durationSec / 4)}s</span>
            <span>{Math.floor(durationSec / 2)}s</span>
            <span>{Math.floor((durationSec * 3) / 4)}s</span>
            <span>{durationSec}s</span>
          </div>

          {/* Heatmap buckets */}
          <div className="relative flex h-12 gap-px overflow-hidden rounded">
            {buckets.map((bucket, i) => (
              <button
                key={i}
                className="flex-1 transition-all hover:brightness-125"
                style={{
                  backgroundColor: getBucketColor(bucket.severity, bucket.density),
                }}
                onMouseEnter={() => setHoveredBucket(bucket)}
                onMouseLeave={() => setHoveredBucket(null)}
                onClick={() => handleBucketClick(bucket)}
                title={`t=${bucket.start}-${bucket.end}s: ${bucket.density} phát hiện`}
              />
            ))}
          </div>

          {/* Hover tooltip */}
          {hoveredBucket && hoveredBucket.density > 0 && (
            <div className="absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded border bg-popover px-2 py-1 font-mono text-[10px] shadow-lg">
              t={hoveredBucket.start}-{hoveredBucket.end}s: {hoveredBucket.density}{" "}
              phát hiện
              <br />
              <span style={{ color: getBucketColor(hoveredBucket.severity, 1) }}>
                {(SEVERITY_LABEL[hoveredBucket.severity] ?? hoveredBucket.severity).toUpperCase()}
              </span>
            </div>
          )}
        </div>

        {/* Detection markers */}
        {anomalyMarkers.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Phát hiện
            </span>
            <div className="max-h-32 space-y-1 overflow-auto">
              {anomalyMarkers.map((anomaly) => (
                <button
                  key={anomaly.id}
                  onClick={() => handleAnomalyClick(anomaly)}
                  className={`
                    flex w-full items-center gap-2 rounded border px-2 py-1.5
                    text-left transition-colors
                    ${selectedAnomaly?.id === anomaly.id ? "bg-accent" : "hover:bg-accent"}
                  `}
                  style={{
                    borderColor: `${SEVERITY_COLORS[anomaly.severity]}40`,
                  }}
                >
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: SEVERITY_COLORS[anomaly.severity] }}
                  />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    t={relativeSpan(anomaly).start.toFixed(1)}s
                  </span>
                  <span className="flex-1 truncate text-xs">
                    {anomaly.title}
                  </span>
                  <Badge
                    variant="outline"
                    className="text-[9px]"
                    style={{
                      borderColor: SEVERITY_COLORS[anomaly.severity],
                      color: SEVERITY_COLORS[anomaly.severity],
                    }}
                  >
                    {anomaly.kind}
                  </Badge>
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* No detections */}
        {anomalies.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
            <AlertCircleIcon className="size-4" />
            <span>Không có phát hiện trong khoảng thời gian này</span>
          </div>
        )}

        {/* Selected anomaly details */}
        {selectedAnomaly && (
          <div
            className="rounded border p-2"
            style={{
              borderColor: `${SEVERITY_COLORS[selectedAnomaly.severity]}40`,
              backgroundColor: `${SEVERITY_COLORS[selectedAnomaly.severity]}08`,
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: SEVERITY_COLORS[selectedAnomaly.severity] }}
              />
              <span className="flex-1 text-xs font-medium">
                {selectedAnomaly.title}
              </span>
              <Badge
                variant="outline"
                className="text-[9px]"
                style={{
                  borderColor: SEVERITY_COLORS[selectedAnomaly.severity],
                  color: SEVERITY_COLORS[selectedAnomaly.severity],
                }}
              >
                {SEVERITY_LABEL[selectedAnomaly.severity] ?? selectedAnomaly.severity}
              </Badge>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {selectedAnomaly.metric}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
