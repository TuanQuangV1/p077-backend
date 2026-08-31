"use client"

import type { Anomaly, HealthStatus, HealthSummary, LogEvent, Rosbag, TopicStat } from "@/lib/types"
import { computeSystemMetrics } from "@/lib/health-engine"
import { cn } from "@/lib/utils"

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

function GaugeMini({
  score,
  status,
  size = 64,
  strokeWidth,
}: {
  score: number
  status: HealthStatus
  size?: number
  strokeWidth?: number
}) {
  const actualStroke = strokeWidth ?? (size <= 32 ? 3 : 6)
  const r = (size - actualStroke) / 2
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

  const clampedScore = Math.max(0, Math.min(100, score))
  const sweepAngle = (clampedScore / 100) * totalAngle
  const valueAngle = startAngle + sweepAngle
  const valueRad = (valueAngle * Math.PI) / 180

  const valuePath = clampedScore > 0
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
        stroke="currentColor"
        className="text-border/70 dark:text-border/40"
        strokeWidth={actualStroke}
        strokeLinecap="round"
      />
      <path
        d={valuePath}
        fill="none"
        stroke={STATUS_COLORS[status] || "#28a745"}
        strokeWidth={actualStroke}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
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
        <GaugeMini score={score} status={status} size={48} strokeWidth={5} />
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

export function HealthBadge({
  score,
  status,
  className,
}: {
  score: number
  status: HealthStatus | string
  className?: string
}) {
  const normStatus = (
    status === "green" || status === "yellow" || status === "red"
      ? status
      : "green"
  ) as HealthStatus
  const color = STATUS_COLORS[normStatus] || "#28a745"
  const label = STATUS_LABELS[normStatus] || "NOMINAL"

  return (
    <div
      className={cn(
        "group relative inline-flex items-center gap-3 rounded-xl border border-border/90 bg-card px-3.5 py-1.5 shadow-xs transition-all hover:border-primary/50 cursor-help select-none",
        className
      )}
    >
      {/* Radial Speedometer Dial */}
      <div className="relative flex items-center justify-center">
        <GaugeMini score={score} status={normStatus} size={34} strokeWidth={4} />
        <span
          className="absolute size-2 rounded-full animate-pulse"
          style={{ backgroundColor: color }}
        />
      </div>

      {/* Numerical Score & Status Label */}
      <div className="flex flex-col text-left font-mono leading-tight">
        <div className="flex items-baseline gap-1">
          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
            Health
          </span>
          <span className="text-sm font-black tracking-tight" style={{ color }}>
            {score}
          </span>
          <span className="text-[10px] text-muted-foreground">/100</span>
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span
            className="rounded-sm px-1.5 py-0.2 text-[9px] font-black uppercase tracking-wider"
            style={{
              backgroundColor: `${color}20`,
              color,
              border: `1px solid ${color}40`,
            }}
          >
            {label}
          </span>
        </div>
      </div>

      {/* Floating Detailed Breakdown Tooltip on Hover */}
      <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-72 -translate-x-1/2 rounded-xl border border-border/90 bg-popover/95 p-3.5 font-sans shadow-2xl backdrop-blur-md transition-all duration-200 opacity-0 scale-95 origin-top group-hover:opacity-100 group-hover:scale-100 group-hover:pointer-events-auto">
        <div className="space-y-2.5 text-left font-mono">
          <div className="flex items-center justify-between border-b border-border/60 pb-2">
            <span className="text-xs font-bold text-foreground">
              Reliability Score
            </span>
            <span
              className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{
                backgroundColor: `${color}20`,
                color,
                border: `1px solid ${color}40`,
              }}
            >
              {score}/100 · {label}
            </span>
          </div>

          {/* Linear Spectrum Range Bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-[9px] text-muted-foreground">
              <span className="text-destructive font-semibold">&lt;60 Fault</span>
              <span className="text-amber-500 font-semibold">60-85 Degraded</span>
              <span className="text-emerald-500 font-semibold">&gt;85 Nominal</span>
            </div>
            <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden flex">
              <div className="w-[60%] bg-destructive/80" />
              <div className="w-[25%] bg-amber-500/80" />
              <div className="w-[15%] bg-emerald-500/80" />
            </div>
          </div>

          <p className="text-[10.5px] font-sans text-muted-foreground leading-relaxed">
            Composite index calculated across multi-topic cadence, TF2 tree continuity, log fault streams, and transport latency.
          </p>
        </div>
      </div>
    </div>
  )
}

export function HealthScoreHeroCard({
  health,
}: {
  health: HealthSummary
  durationSec?: number
  anomaliesCount?: number
  rosbag?: Rosbag | null
  topics?: TopicStat[]
  anomalies?: Anomaly[]
  logs?: LogEvent[]
}) {
  const normStatus = (
    health.status === "green" || health.status === "yellow" || health.status === "red"
      ? health.status
      : "green"
  ) as HealthStatus
  const color = STATUS_COLORS[normStatus] || "#28a745"
  const label = STATUS_LABELS[normStatus] || "NOMINAL"
  const score = health.health_score

  const groups = [
    { key: "frequency", label: "Topic Cadence", score: health.summary?.groups?.frequency?.score ?? 85, icon: "Hz" },
    { key: "tf", label: "TF2 Spatial Tree", score: health.summary?.groups?.tf?.score ?? 95, icon: "TF" },
    { key: "log", label: "ROS Log Stream", score: health.summary?.groups?.log?.score ?? 70, icon: "LOG" },
    { key: "latency", label: "Transport Latency", score: health.summary?.groups?.latency?.score ?? 60, icon: "LAT" },
    { key: "payload", label: "Throughput", score: health.summary?.groups?.payload?.score ?? 100, icon: "PLD" },
  ]

  const getSubColor = (s: number) => (s >= 85 ? "#10b981" : s >= 60 ? "#f59e0b" : "#ef4444")

  return (
    <div className="rounded-2xl border border-border/80 bg-card/90 p-5 shadow-xs backdrop-blur-md">
      <div className="grid gap-6 md:grid-cols-12 items-center">
        {/* Left Column: Speedometer Radial Gauge */}
        <div className="flex flex-col items-center justify-center text-center md:col-span-4 border-b md:border-b-0 md:border-r border-border/60 pb-4 md:pb-0 md:pr-4">
          <div className="relative flex items-center justify-center">
            <GaugeMini score={score} status={normStatus} size={92} strokeWidth={8} />
            <div className="absolute inset-0 flex flex-col items-center justify-center font-mono leading-none">
              <span className="text-2xl font-black tracking-tight" style={{ color }}>
                {score}
              </span>
              <span className="text-[10px] text-muted-foreground mt-0.5">/100</span>
            </div>
          </div>

          <div
            className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold font-mono uppercase tracking-wider"
            style={{
              backgroundColor: `${color}15`,
              color,
              border: `1px solid ${color}40`,
            }}
          >
            <span className="size-2 rounded-full animate-pulse" style={{ backgroundColor: color }} />
            <span>{label}</span>
          </div>
          <span className="mt-1 text-[11px] text-muted-foreground font-mono">System Reliability Score</span>
        </div>

        {/* Right Column: Spectrum Scale & 5 Subsystems */}
        <div className="space-y-3.5 md:col-span-8">
          {/* Top Spectrum Header */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="font-semibold text-foreground">Operational Reliability Scale</span>
              <span className="text-muted-foreground text-[11px]">
                Index: <strong style={{ color }}>{score}</strong> / 100
              </span>
            </div>

            {/* Spectrum Bar with Indicator Marker */}
            <div className="relative pt-1 pb-2">
              <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden flex">
                <div className="w-[60%] bg-destructive/80" />
                <div className="w-[25%] bg-amber-500/80" />
                <div className="w-[15%] bg-emerald-500/80" />
              </div>

              {/* Marker pin */}
              <div
                className="absolute top-0 -translate-x-1/2 flex flex-col items-center transition-all duration-300"
                style={{ left: `${Math.max(3, Math.min(97, score))}%` }}
              >
                <div
                  className="size-3.5 rounded-full border-2 border-background shadow-md"
                  style={{ backgroundColor: color }}
                />
              </div>

              <div className="mt-1.5 flex justify-between text-[9px] font-mono text-muted-foreground">
                <span className="text-destructive font-semibold">0-59 Faulted</span>
                <span className="text-amber-500 font-semibold">60-84 Degraded</span>
                <span className="text-emerald-500 font-semibold">85-100 Nominal</span>
              </div>
            </div>
          </div>

          {/* 5 Subsystem Scores Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 pt-1">
            {groups.map((group) => {
              const subColor = getSubColor(group.score)
              return (
                <div
                  key={group.key}
                  className="rounded-lg border border-border/60 bg-muted/20 p-2 text-left font-mono"
                >
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{group.icon}</span>
                    <span className="font-bold text-xs" style={{ color: subColor }}>{group.score}%</span>
                  </div>
                  <div className="mt-1 h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${group.score}%`, backgroundColor: subColor }} />
                  </div>
                  <div className="mt-1 truncate text-[10px] font-medium text-foreground/80 font-sans">
                    {group.label}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export function OperationalMetricsRibbon({
  rosbag,
  topics,
  anomalies = [],
  logs = [],
  health,
  className,
}: {
  rosbag?: Rosbag | null
  topics?: TopicStat[]
  anomalies?: Anomaly[]
  logs?: LogEvent[]
  health?: HealthSummary | null
  className?: string
}) {
  const metrics = computeSystemMetrics({
    rosbag: rosbag ?? null,
    topics,
    anomalies,
    logs,
    health,
  })

  return (
    <div className={cn("rounded-2xl border border-border/80 bg-card/90 p-4 shadow-xs backdrop-blur-md", className)}>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono">
        {/* Card 1: P95 Transport Latency */}
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3 hover:border-primary/40 transition-colors flex flex-col justify-between">
          <div className="text-[11px] text-muted-foreground font-semibold flex items-center justify-between">
            <span>P95 Latency</span>
            <span className="text-[10px] text-primary font-bold">ms</span>
          </div>
          <div className="mt-2 text-lg font-black text-foreground tracking-tight">
            {metrics.p95LatencyMs} <span className="text-xs font-normal text-muted-foreground">ms</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate font-sans">
            P99: {metrics.p99LatencyMs}ms · Net Delay
          </div>
        </div>

        {/* Card 2: Timestamp Jitter */}
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3 hover:border-primary/40 transition-colors flex flex-col justify-between">
          <div className="text-[11px] text-muted-foreground font-semibold flex items-center justify-between">
            <span>Time Jitter</span>
            <span className="text-[10px] text-primary font-bold">std</span>
          </div>
          <div className="mt-2 text-lg font-black text-foreground tracking-tight">
            ±{metrics.timestampJitterMs} <span className="text-xs font-normal text-muted-foreground">ms</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate font-sans">
            IMU/LiDAR cyclic variance
          </div>
        </div>

        {/* Card 3: Worst Frequency Gap */}
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3 hover:border-primary/40 transition-colors flex flex-col justify-between">
          <div className="text-[11px] text-muted-foreground font-semibold flex items-center justify-between">
            <span>Max Freq Gap</span>
            <span className="text-[10px] text-amber-500 font-bold">gap</span>
          </div>
          <div className="mt-2 text-lg font-black text-amber-500 tracking-tight">
            {metrics.worstGapSec > 0 ? `${metrics.worstGapSec}s` : "0.0s"}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate font-sans" title={metrics.worstGapTopic}>
            {metrics.worstGapTopic}
          </div>
        </div>

        {/* Card 4: Top Degrading Sensor */}
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3 hover:border-primary/40 transition-colors flex flex-col justify-between">
          <div className="text-[11px] text-muted-foreground font-semibold flex items-center justify-between">
            <span>Max Rate Drop</span>
            <span className="text-[10px] text-destructive font-bold">drop</span>
          </div>
          <div className="mt-2 text-lg font-black text-destructive tracking-tight">
            {metrics.topDropPct > 0 ? `-${metrics.topDropPct}%` : "0%"}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate font-sans" title={metrics.topDropTopic}>
            {metrics.topDropTopic}
          </div>
        </div>

        {/* Card 5: TF2 Spatial Integrity */}
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3 hover:border-primary/40 transition-colors flex flex-col justify-between">
          <div className="text-[11px] text-muted-foreground font-semibold flex items-center justify-between">
            <span>TF2 Spatial</span>
            <span className="text-[10px] text-emerald-500 font-bold">tree</span>
          </div>
          <div className="mt-2 text-lg font-black text-foreground tracking-tight">
            {metrics.tfContinuityPct}%
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate font-sans">
            Tree continuity status
          </div>
        </div>

        {/* Card 6: Node & Log Integrity */}
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3 hover:border-primary/40 transition-colors flex flex-col justify-between">
          <div className="text-[11px] text-muted-foreground font-semibold flex items-center justify-between">
            <span>Node Health</span>
            <span className="text-[10px] text-primary font-bold">nodes</span>
          </div>
          <div className="mt-2 text-lg font-black text-foreground tracking-tight">
            {metrics.activeNodesCount}/{metrics.totalNodesCount}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate font-sans">
            {metrics.silentTopicsCount > 0 ? `${metrics.silentTopicsCount} silent nodes` : `${metrics.errorLogCount} error logs`}
          </div>
        </div>
      </div>
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
