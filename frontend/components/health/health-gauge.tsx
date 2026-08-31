"use client"

import type { HealthStatus } from "@/lib/types"

interface HealthGaugeProps {
  score: number
  status: HealthStatus
  size?: "sm" | "md" | "lg"
}

const STATUS_COLORS: Record<HealthStatus, string> = {
  green: "#28a745",
  yellow: "#ffc107",
  red: "#dc3545",
}

const STATUS_LABELS: Record<HealthStatus, string> = {
  green: "NOMINAL",
  yellow: "DEGRADED",
  red: "FAULTED",
}

function GaugeArc({ score, status }: { score: number; status: HealthStatus }) {
  const size = 160
  const strokeWidth = 12
  const r = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2

  const startAngle = 135
  const endAngle = 405
  const totalAngle = endAngle - startAngle

  const bgStartRad = (startAngle * Math.PI) / 180
  const bgEndRad = (endAngle * Math.PI) / 180

  const bgPath = `
    M ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)}
    A ${r} ${r} 0 1 1 ${cx + r * Math.cos(bgEndRad)} ${cy + r * Math.sin(bgEndRad)}
  `

  const sweepAngle = (score / 100) * totalAngle
  const valueAngle = startAngle + sweepAngle
  const valueRad = (valueAngle * Math.PI) / 180

  const valuePath = score > 0
    ? `
      M ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)}
      A ${r} ${r} 0 ${sweepAngle > 180 ? 1 : 0} 1 ${cx + r * Math.cos(valueRad)} ${cy + r * Math.sin(valueRad)}
    `
    : `M ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)} L ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)}`

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <path
        d={bgPath}
        fill="none"
        stroke="var(--border)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d={valuePath}
        fill="none"
        stroke={STATUS_COLORS[status]}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
    </svg>
  )
}

function GaugeMini({ score, status }: { score: number; status: HealthStatus }) {
  const size = 64
  const strokeWidth = 6
  const r = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2

  const startAngle = 135
  const endAngle = 405
  const totalAngle = endAngle - startAngle

  const bgStartRad = (startAngle * Math.PI) / 180
  const bgEndRad = (endAngle * Math.PI) / 180

  const bgPath = `
    M ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)}
    A ${r} ${r} 0 1 1 ${cx + r * Math.cos(bgEndRad)} ${cy + r * Math.sin(bgEndRad)}
  `

  const sweepAngle = (score / 100) * totalAngle
  const valueAngle = startAngle + sweepAngle
  const valueRad = (valueAngle * Math.PI) / 180

  const valuePath = score > 0
    ? `
      M ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)}
      A ${r} ${r} 0 ${sweepAngle > 180 ? 1 : 0} 1 ${cx + r * Math.cos(valueRad)} ${cy + r * Math.sin(valueRad)}
    `
    : `M ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)} L ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)}`

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <path
        d={bgPath}
        fill="none"
        stroke="var(--border)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d={valuePath}
        fill="none"
        stroke={STATUS_COLORS[status]}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function HealthGauge({ score, status, size = "md" }: HealthGaugeProps) {
  const color = STATUS_COLORS[status]
  const label = STATUS_LABELS[status]

  if (size === "sm") {
    return (
      <div className="flex items-center gap-2 font-mono">
        <GaugeMini score={score} status={status} />
        <div>
          <div className="text-lg font-bold tabular-nums" style={{ color }}>
            {score}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {label}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <GaugeArc score={score} status={status} />
        <div className="absolute inset-0 flex flex-col items-center justify-center font-mono">
          <span
            className="text-3xl font-bold tabular-nums"
            style={{ color }}
          >
            {score}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            /100
          </span>
        </div>
      </div>
      <div
        className="mt-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider font-mono"
        style={{
          backgroundColor: `${color}20`,
          color,
          border: `1px solid ${color}40`,
        }}
      >
        {label}
      </div>
    </div>
  )
}

export function HealthBadge({ score, status }: { score: number; status: HealthStatus }) {
  const color = STATUS_COLORS[status]
  const label = STATUS_LABELS[status]

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
      <span>{label}</span>
    </div>
  )
}

export function HealthScoreCard({
  score,
  status,
  worstSeverity,
  topDropPct,
  topDropTopic,
  duration,
  messageCount,
}: {
  score: number
  status: HealthStatus
  worstSeverity: string | null
  topDropPct: number
  topDropTopic: string | null
  duration: number
  messageCount: number
}) {
  const color = STATUS_COLORS[status]

  const severityColor =
    worstSeverity === "critical" ? "#dc3545"
    : worstSeverity === "high" ? "#fd7e14"
    : worstSeverity === "medium" ? "#ffc107"
    : "#6c757d"

  const dropColor =
    topDropPct > 50 ? "#dc3545"
    : topDropPct > 30 ? "#ffc107"
    : "#6c757d"

  return (
    <div className="grid gap-3 sm:grid-cols-4 font-mono">
      {/* Health Score */}
      <div
        className="flex flex-col items-center justify-center rounded-lg border p-4"
        style={{ borderColor: `${color}40`, backgroundColor: `${color}05` }}
      >
        <HealthGauge score={score} status={status} size="sm" />
        <div className="mt-2 text-center text-[10px] text-muted-foreground font-sans">
          Health Index Score
        </div>
      </div>

      {/* Worst Severity */}
      <div className="flex flex-col items-center justify-center rounded-lg border p-4">
        <span
          className="text-2xl font-bold uppercase"
          style={{ color: severityColor }}
        >
          {worstSeverity ?? "Nominal"}
        </span>
        <span className="mt-1 text-[10px] text-muted-foreground font-sans">
          Worst Fault Severity
        </span>
      </div>

      {/* Top Drop */}
      <div className="flex flex-col items-center justify-center rounded-lg border p-4">
        <span
          className="text-2xl font-bold tabular-nums"
          style={{ color: dropColor }}
        >
          {topDropPct > 0 ? `-${topDropPct}%` : "0%"}
        </span>
        <span className="mt-1 truncate max-w-full text-[10px] text-muted-foreground">
          {topDropTopic ?? "Zero Drop"}
        </span>
      </div>

      {/* Duration */}
      <div className="flex flex-col items-center justify-center rounded-lg border p-4">
        <span className="text-2xl font-bold tabular-nums">
          {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, "0")}
        </span>
        <span className="mt-1 text-[10px] text-muted-foreground">
          {messageCount.toLocaleString()} messages
        </span>
      </div>
    </div>
  )
}
