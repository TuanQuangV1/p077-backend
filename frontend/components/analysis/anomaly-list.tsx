"use client"

import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SeverityBadge } from "@/components/telemetry"
import { clock, SEVERITY_ORDER, severityColor } from "@/lib/api"
import type { Anomaly, Severity } from "@/lib/types"
import { cn } from "@/lib/utils"
import { relativeSpan } from "@/lib/anomaly-groups"

export function AnomalyList({
  anomalies,
  selectedId,
  severities,
  onSeveritiesChange,
  onSelect,
}: {
  anomalies: Anomaly[]
  selectedId: string | null
  severities: Severity[]
  onSeveritiesChange: (s: Severity[]) => void
  onSelect: (a: Anomaly) => void
}) {
  const visible = anomalies.filter((a) => severities.length === 0 || severities.includes(a.severity))

  const severityCounts = {
    critical: anomalies.filter((a) => a.severity === "critical").length,
    high: anomalies.filter((a) => a.severity === "high").length,
    medium: anomalies.filter((a) => a.severity === "medium").length,
    low: anomalies.filter((a) => a.severity === "low").length,
  }

  const toggleSeverity = (s: Severity) => {
    if (severities.includes(s)) {
      onSeveritiesChange(severities.filter((item) => item !== s))
    } else {
      onSeveritiesChange([...severities, s])
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header & Filter Tabs */}
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5 bg-card/40 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground font-mono">
            Detected Faults
          </span>
          <Badge variant="secondary" className="font-mono text-[10px] font-bold">
            {visible.length}/{anomalies.length}
          </Badge>
        </div>

        {/* Quick Filter Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-none font-mono shrink-0">
          <button
            type="button"
            onClick={() => onSeveritiesChange([])}
            className={cn(
              "px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer shrink-0",
              severities.length === 0
                ? "bg-primary text-primary-foreground font-bold"
                : "bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground"
            )}
          >
            All
          </button>
          {SEVERITY_ORDER.map((s) => {
            const count = severityCounts[s]
            if (count === 0 && severities.length === 0) return null
            const isActive = severities.includes(s)
            const color = severityColor[s]

            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSeverity(s)}
                className={cn(
                  "px-2 py-0.5 rounded text-[10px] transition-all cursor-pointer shrink-0 flex items-center gap-1 border",
                  isActive
                    ? "border-current font-bold"
                    : "border-transparent bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground"
                )}
                style={isActive ? { color, backgroundColor: `${color}15`, borderColor: `${color}50` } : undefined}
              >
                <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span>{s === "critical" ? "Crit" : s === "high" ? "High" : s === "medium" ? "Med" : "Low"}</span>
                <span className="opacity-70 text-[9px]">({count})</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Anomaly Cards List */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-1.5 space-y-1">
        <ul className="flex flex-col divide-y divide-border/40 space-y-1">
          {visible.map((a) => {
            const isSelected = a.id === selectedId
            const color = severityColor[a.severity]

            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onSelect(a)}
                  className={cn(
                    "flex w-full flex-col gap-1.5 rounded-lg p-2.5 text-left cursor-pointer transition-all border",
                    isSelected
                      ? "border-primary bg-accent/70 shadow-xs ring-1 ring-primary/40"
                      : "border-transparent hover:bg-accent/40 hover:border-border/60"
                  )}
                  style={isSelected ? { borderLeftWidth: 3, borderLeftColor: color } : undefined}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <SeverityBadge severity={a.severity} />
                    <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground font-semibold">
                      t={clock(relativeSpan(a).start, false)}
                    </span>
                  </div>

                  <span className="text-xs font-semibold leading-snug text-foreground font-sans">
                    {a.title}
                  </span>

                  {a.metric && (
                    <span className="line-clamp-2 font-mono text-[10px] text-muted-foreground/90 bg-muted/30 px-1.5 py-0.5 rounded">
                      {a.metric}
                    </span>
                  )}

                  <div className="flex items-center justify-between gap-1.5 font-mono text-[10px] pt-0.5">
                    <span className="truncate rounded bg-background/80 border border-border/70 px-1.5 py-0.5 text-foreground/80 font-medium">
                      {a.topics[0] ?? "system"}
                    </span>
                    <span className="shrink-0 font-semibold" style={{ color }}>
                      {(a.confidence * 100).toFixed(0)}% conf
                    </span>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
