"use client"

import { AlertTriangleIcon, AlertCircleIcon, ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Anomaly, LogEvent, Severity } from "@/lib/types"

interface LogSeverityPanelProps {
  logs: LogEvent[]
  anomalies: Anomaly[]
}

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#6c757d",
}

function LogStatCard({
  label,
  count,
  color,
  isAlert,
}: {
  label: string
  count: number
  color: string
  isAlert: boolean
}) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-lg border p-3"
      style={{
        borderColor: isAlert ? color : "var(--border)",
        backgroundColor: isAlert ? `${color}10` : "transparent",
      }}
    >
      <span
        className="text-2xl font-bold tabular-nums"
        style={{ color }}
      >
        {count}
      </span>
      <span
        className="text-[10px] uppercase tracking-wider"
        style={{ color: isAlert ? color : "var(--muted-foreground)" }}
      >
        {label}
      </span>
    </div>
  )
}

function LogBanner({
  level,
  message,
  timestamp,
}: {
  level: string
  message: string
  timestamp: number
}) {
  const isError = level === "error"
  const isFatal = level === "fatal"
  const color = isFatal ? "#dc3545" : isError ? "#dc3545" : "#ffc107"

  return (
    <div
      className="flex items-start gap-2 rounded-lg border p-2"
      style={{
        borderColor: `${color}40`,
        backgroundColor: `${color}08`,
      }}
    >
      {isFatal ? (
        <ShieldAlertIcon className="size-4 shrink-0" style={{ color }} />
      ) : isError ? (
        <AlertCircleIcon className="size-4 shrink-0" style={{ color }} />
      ) : (
        <AlertTriangleIcon className="size-4 shrink-0" style={{ color }} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="text-[9px]"
            style={{ borderColor: color, color }}
          >
            {level.toUpperCase()}
          </Badge>
          <span className="font-mono text-[10px] text-muted-foreground">
            t={timestamp.toFixed(1)}s
          </span>
        </div>
        <p className="mt-1 truncate text-xs">{message}</p>
      </div>
    </div>
  )
}

export function LogSeverityPanel({ logs, anomalies }: LogSeverityPanelProps) {
  // Count by level
  const fatalCount = logs.filter((l) => l.level === "fatal").length
  const errorCount = logs.filter((l) => l.level === "error").length
  const warnCount = logs.filter((l) => l.level === "warn").length

  // Get latest error and warn logs
  const errorLogs = logs
    .filter((l) => l.level === "error")
    .sort((a, b) => b.tSec - a.tSec)
  const warnLogs = logs
    .filter((l) => l.level === "warn")
    .sort((a, b) => b.tSec - a.tSec)

  // Get log-related anomalies
  const logAnomalies = anomalies.filter(
    (a) =>
      a.kind === "tf_timeout" ||
      a.kind === "cpu_spike" ||
      a.kind === "nav_recovery",
  )

  const latestError = errorLogs[0]
  const latestWarn = warnLogs[0]

  const hasFatal = fatalCount > 0
  const hasError = errorCount > 0
  const hasWarn = warnCount > 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertCircleIcon className="size-4" />
          Mức độ nghiêm trọng Nhật ký (Log System Severity)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Stat Cards */}
        <div className="grid grid-cols-3 gap-2">
          <LogStatCard
            label="NGHIÊM TRỌNG (FATAL)"
            count={fatalCount}
            color="#dc3545"
            isAlert={hasFatal}
          />
          <LogStatCard
            label="LỖI (ERROR)"
            count={errorCount}
            color="#dc3545"
            isAlert={hasError}
          />
          <LogStatCard
            label="CẢNH BÁO (WARN)"
            count={warnCount}
            color="#ffc107"
            isAlert={hasWarn}
          />
        </div>

        {/* Log Anomalies Banner */}
        {logAnomalies.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Anomalies
            </span>
            {logAnomalies.slice(0, 3).map((anomaly) => (
              <div
                key={anomaly.id}
                className="flex items-center gap-2 rounded border border-border bg-card px-2 py-1"
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: SEVERITY_COLORS[anomaly.severity] }}
                />
                <span className="flex-1 truncate text-xs">{anomaly.title}</span>
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
              </div>
            ))}
          </div>
        )}

        {/* Latest Error */}
        {latestError && (
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Latest ERROR
            </span>
            <LogBanner
              level={latestError.level}
              message={latestError.message}
              timestamp={latestError.tSec}
            />
          </div>
        )}

        {/* Latest Warn */}
        {latestWarn && (
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Latest WARN
            </span>
            <LogBanner
              level={latestWarn.level}
              message={latestWarn.message}
              timestamp={latestWarn.tSec}
            />
          </div>
        )}

        {/* No Issues */}
        {!hasFatal && !hasError && !hasWarn && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            Không phát hiện nhật ký LỖI (ERROR) hoặc CẢNH BÁO (WARN)
          </p>
        )}
      </CardContent>
    </Card>
  )
}
