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
  green: "KHOẺ MẠNH",
  yellow: "SUY GIẢM",
  red: "SỰ CỐ",
}

function GaugeArc({ score, status }: { score: number; status: HealthStatus }) {
  const size = 160
  const strokeWidth = 12
  const r = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2

  // Arc spans 270 degrees (from 135 to 405 degrees, leaving bottom-right gap)
  const startAngle = 135
  const endAngle = 405
  const totalAngle = endAngle - startAngle

  // Background arc
  const bgStartRad = (startAngle * Math.PI) / 180
  const bgEndRad = (endAngle * Math.PI) / 180

  const bgPath = `
    M ${cx + r * Math.cos(bgStartRad)} ${cy + r * Math.sin(bgStartRad)}
    A ${r} ${r} 0 1 1 ${cx + r * Math.cos(bgEndRad)} ${cy + r * Math.sin(bgEndRad)}
  `

  // Value arc — large-arc-flag must reflect the actual sweep angle (> 180deg),
  // not the raw score, or SVG draws the complementary (wrong) arc.
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
      {/* Background track */}
      <path
        d={bgPath}
        fill="none"
        stroke="var(--border)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {/* Value arc */}
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
      <div className="flex items-center gap-2">
        <GaugeMini score={score} status={status} />
        <div>
          <div className="text-lg font-bold tabular-nums" style={{ color }}>
            {score}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
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
        <div className="absolute inset-0 flex flex-col items-center justify-center">
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
        className="mt-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider"
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
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold"
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
      <span>HS {score}</span>
      <span className="text-muted-foreground">|</span>
      <span>{label}</span>
    </div>
  )
}

export interface HealthScoreCardProps {
  metrics: {
    formattedAvgRateHz: string
    rateSubtext: string
    formattedTotalSize: string
    sizeValue: string
    sizeUnit: string
    bandwidthValue: string
    bandwidthUnit: string
    bandwidthSubtext: string
    sensorAvailabilityPct: number
    availabilityStatus: "healthy" | "degraded" | "critical"
    availabilitySubtext: string
    formattedDuration: string
    durationSubtext: string
    formattedMessages: string
    messagesSubtext: string
    totalTopics: number
    healthyTopicsCount: number
  }
}

export function HealthScoreCard({ metrics }: HealthScoreCardProps) {
  const {
    formattedAvgRateHz,
    rateSubtext,
    sizeValue,
    sizeUnit,
    bandwidthSubtext,
    sensorAvailabilityPct,
    availabilityStatus,
    availabilitySubtext,
    formattedDuration,
    durationSubtext,
    formattedMessages,
    messagesSubtext,
    totalTopics,
  } = metrics

  const availabilityColor =
    availabilityStatus === "healthy"
      ? "#28a745"
      : availabilityStatus === "degraded"
      ? "#ffc107"
      : "#dc3545"

  return (
    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      {/* Card 1: System Message Rate */}
      <div className="flex flex-col items-center justify-center rounded-xl border border-border/70 bg-card/60 p-4 text-center transition-colors hover:border-border hover:bg-card/80">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tốc độ xử lý
        </span>
        <div className="my-1.5 flex items-baseline justify-center gap-1">
          <span className="font-mono text-2xl font-bold tracking-tight text-foreground">
            {formattedAvgRateHz}
          </span>
          <span className="text-xs font-medium text-cyan-400/90">Hz (msg/s)</span>
        </div>
        <div className="truncate max-w-full text-[11px] text-muted-foreground">
          {rateSubtext}
        </div>
      </div>

      {/* Card 2: Data Volume & Bandwidth */}
      <div className="flex flex-col items-center justify-center rounded-xl border border-border/70 bg-card/60 p-4 text-center transition-colors hover:border-border hover:bg-card/80">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Dung lượng & Tải
        </span>
        <div className="my-1.5 flex items-baseline justify-center gap-1">
          <span className="font-mono text-2xl font-bold tracking-tight text-foreground">
            {sizeValue}
          </span>
          <span className="text-xs font-medium text-indigo-400/90">{sizeUnit}</span>
        </div>
        <div className="truncate max-w-full text-[11px] text-muted-foreground">
          {bandwidthSubtext}
        </div>
      </div>

      {/* Card 3: Sensor Availability */}
      <div className="flex flex-col items-center justify-center rounded-xl border border-border/70 bg-card/60 p-4 text-center transition-colors hover:border-border hover:bg-card/80">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Độ sẵn sàng cảm biến
        </span>
        <div className="my-1.5 flex items-baseline justify-center">
          <span
            className="font-mono text-2xl font-bold tracking-tight"
            style={{ color: availabilityColor }}
          >
            {sensorAvailabilityPct}%
          </span>
        </div>
        <div className="truncate max-w-full text-[11px] text-muted-foreground">
          {availabilitySubtext}
        </div>
      </div>

      {/* Card 4: Recording Duration */}
      <div className="flex flex-col items-center justify-center rounded-xl border border-border/70 bg-card/60 p-4 text-center transition-colors hover:border-border hover:bg-card/80">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Thời lượng ghi
        </span>
        <div className="my-1.5 flex items-baseline justify-center gap-1">
          <span className="font-mono text-2xl font-bold tracking-tight text-foreground">
            {formattedDuration}
          </span>
          <span className="text-xs font-medium text-violet-400/90">phút</span>
        </div>
        <div className="truncate max-w-full text-[11px] text-muted-foreground">
          {durationSubtext}
        </div>
      </div>

      {/* Card 5: Total Records / Messages */}
      <div className="flex flex-col items-center justify-center rounded-xl border border-border/70 bg-card/60 p-4 text-center transition-colors hover:border-border hover:bg-card/80">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tổng số bản ghi
        </span>
        <div className="my-1.5 flex items-baseline justify-center gap-1">
          <span className="font-mono text-2xl font-bold tracking-tight text-foreground">
            {formattedMessages}
          </span>
          <span className="text-xs font-medium text-violet-400/90">msg</span>
        </div>
        <div className="truncate max-w-full text-[11px] text-muted-foreground">
          {totalTopics} topics đang giám sát
        </div>
      </div>
    </div>
  )
}
