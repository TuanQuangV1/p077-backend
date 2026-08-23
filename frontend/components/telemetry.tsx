import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { severityBorder } from "@/lib/api"
import type { Severity } from "@/lib/types"

/** Compact KPI tile. Value is monospace so columns of numbers line up. */
export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = "default",
  icon,
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
  tone?: "default" | "primary" | "critical" | "ok"
  icon?: ReactNode
}) {
  const toneClass = {
    default: "text-foreground",
    primary: "text-primary",
    critical: "text-critical",
    ok: "text-ok",
  }[tone]

  return (
    <Card className="gap-0 py-4">
      <CardContent className="flex flex-col gap-1.5 px-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
          {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        </div>
        <div className="flex items-baseline gap-1">
          <span className={cn("font-mono text-2xl font-semibold tabular-nums leading-none", toneClass)}>{value}</span>
          {unit ? <span className="font-mono text-xs text-muted-foreground">{unit}</span> : null}
        </div>
        {hint ? <span className="text-[11px] leading-4 text-muted-foreground">{hint}</span> : null}
      </CardContent>
    </Card>
  )
}

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-mono text-[10px] uppercase", severityBorder[severity], className)}>
      {severity}
    </Badge>
  )
}

export function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded" || status === "analyzed" || status === "ok" || status === "published"
      ? "bg-ok"
      : status === "running" || status === "analyzing" || status === "parsing"
        ? "bg-primary animate-pulse"
        : status === "failed" || status === "error" || status === "oom" || status === "timeout"
          ? "bg-critical"
          : status === "queued" || status === "pending" || status === "draft"
            ? "bg-medium"
            : "bg-muted-foreground"
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", color)} aria-hidden />
}

const STATUS_VI: Record<string, string> = {
  succeeded: "thành công",
  analyzed: "đã phân tích",
  ok: "ổn định",
  published: "đã xuất",
  running: "đang chạy",
  analyzing: "đang phân tích",
  parsing: "đang đọc dữ liệu",
  failed: "thất bại",
  error: "lỗi",
  oom: "tràn bộ nhớ",
  timeout: "quá thời gian",
  queued: "đang chờ",
  pending: "chờ duyệt",
  draft: "bản nháp",
}

export function StatusLabel({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs", className)}>
      <StatusDot status={status} />
      {STATUS_VI[status.toLowerCase()] ?? status}
    </span>
  )
}

/** Label/value row used inside inspector panels. */
export function MetaRow({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-right", mono && "font-mono tabular-nums")}>{value}</span>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  badge?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/50 pb-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground text-balance">
            {title}
          </h1>
          {badge}
        </div>
        {description ? (
          typeof description === "string" ? (
            <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : (
            <div className="text-xs text-muted-foreground">{description}</div>
          )
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  )
}
