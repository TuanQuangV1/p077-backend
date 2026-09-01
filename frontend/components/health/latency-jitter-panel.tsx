"use client"

import { useState } from "react"
import { ClockIcon, AlertTriangleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Anomaly, LatencyWindow } from "@/lib/types"
import { relativeSpan } from "@/lib/anomaly-groups"

interface LatencyJitterPanelProps {
  /** One transport-timing slice per time bucket, from the run's window export. */
  windows: LatencyWindow[]
  latencyAnomalies: Anomaly[]
}

type ViewMode = "latency" | "jitter" | "clock"

interface ModeConfig {
  label: string
  help: string
  /** Detector threshold for this metric, in ms — matches the backend defaults
   *  in `diagnostics_config.py` (max_gap_burst_sec, timestamp_jitter_max_sec,
   *  clock_drift_max_sec). */
  thresholdMs: number
  value: (w: LatencyWindow) => number | null
}

const MODES: Record<ViewMode, ModeConfig> = {
  latency: {
    label: "Max Publish Gap",
    help: "Largest gap between consecutive messages on any topic in the window",
    thresholdMs: 1000,
    value: (w) => w.maxGapMs,
  },
  jitter: {
    label: "Interval Jitter",
    help: "Worst standard deviation of inter-message publishing period",
    thresholdMs: 20,
    value: (w) => w.jitterMs,
  },
  clock: {
    label: "Clock Drift",
    help: "Mean |bag_time − header.stamp| across topics carrying header stamps",
    thresholdMs: 100,
    value: (w) => w.driftMs,
  },
}

function TimingBarChart({ data, threshold }: { data: number[]; threshold: number }) {
  const maxVal = Math.max(...data, threshold)
  const height = 80

  return (
    <div className="relative h-[80px] border-b border-border">
      <div
        className="absolute left-0 right-0 border-t-2 border-dashed border-red-400"
        style={{ bottom: `${(threshold / maxVal) * height}px` }}
      >
        <span className="absolute -top-4 right-0 text-[9px] text-red-400 font-mono">
          {threshold}ms
        </span>
      </div>

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

export function LatencyJitterPanel({ windows, latencyAnomalies }: LatencyJitterPanelProps) {
  const [mode, setMode] = useState<ViewMode>("latency")
  const config = MODES[mode]

  if (windows.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClockIcon className="size-4" />
            Timestamp Jitter & Transport Latency
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-6 text-center text-xs text-muted-foreground font-mono">
            No window-level timing data for this run.
          </p>
        </CardContent>
      </Card>
    )
  }

  const samples = windows.map(config.value)
  const measured = samples.filter((v): v is number => v != null)
  const hasData = measured.length > 0

  // Clock drift is the only metric that can be entirely absent (a run whose
  // topics carry no header stamps); gap and jitter always resolve to a number.
  const data = samples.map((v) => v ?? 0)
  const highCount = measured.filter((v) => v > config.thresholdMs).length
  const maxVal = hasData ? Math.max(...measured) : 0
  const avgVal = hasData ? measured.reduce((a, b) => a + b, 0) / measured.length : 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClockIcon className="size-4" />
            Timestamp Jitter & Transport Latency
          </CardTitle>
        </div>
        <div className="mt-2 flex gap-1">
          {(Object.keys(MODES) as ViewMode[]).map((m) => (
            <Button
              key={m}
              variant={mode === m ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[10px] cursor-pointer"
              onClick={() => setMode(m)}
            >
              {MODES[m].label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {mode === "clock" && !hasData ? (
          <p className="py-6 text-center text-xs text-muted-foreground font-mono">
            No topic in this run carries header timestamps.
          </p>
        ) : (
          <>
            <TimingBarChart data={data} threshold={config.thresholdMs} />

            <div className="grid grid-cols-3 gap-2 text-center font-mono">
              <div>
                <span className="text-lg font-bold tabular-nums">{maxVal.toFixed(0)}</span>
                <span className="text-xs text-muted-foreground ml-1">ms max</span>
              </div>
              <div>
                <span className="text-lg font-bold tabular-nums">{avgVal.toFixed(0)}</span>
                <span className="text-xs text-muted-foreground ml-1">ms avg</span>
              </div>
              <div>
                <span
                  className={`text-lg font-bold tabular-nums ${highCount > 0 ? "text-red-500" : ""}`}
                >
                  {highCount}
                </span>
                <span className="text-xs text-muted-foreground ml-1">
                  {">"}{config.thresholdMs}ms
                </span>
              </div>
            </div>
          </>
        )}

        <p className="text-[10px] text-muted-foreground font-mono">{config.help}</p>

        {latencyAnomalies.length > 0 && (
          <div className="flex items-center gap-2 rounded border border-border bg-card p-2">
            <AlertTriangleIcon className="size-4 text-amber-500" />
            <div className="flex-1">
              <p className="text-xs font-medium">
                Detected {latencyAnomalies.length} transport timing anomalies
              </p>
              <p className="text-[10px] text-muted-foreground font-mono">
                First onset at t={latencyAnomalies[0] ? relativeSpan(latencyAnomalies[0]).start.toFixed(0) : "?"}s
              </p>
            </div>
            <Badge
              variant="outline"
              className="text-[9px] font-mono"
              style={{ borderColor: "#ffc107", color: "#ffc107" }}
            >
              {latencyAnomalies[0]?.kind}
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
