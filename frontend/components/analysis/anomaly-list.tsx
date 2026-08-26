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

  // Calculate severity counts
  const counts = {
    critical: anomalies.filter(a => a.severity === "critical").length,
    high: anomalies.filter(a => a.severity === "high").length,
    medium: anomalies.filter(a => a.severity === "medium").length,
    low: anomalies.filter(a => a.severity === "low").length,
  }

  return (
    <div className="flex h-full min-h-[440px] max-h-[600px] flex-col">
      <div className="flex flex-col gap-2 border-b border-border/70 px-3 py-2 bg-muted/10">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Lọc theo mức độ nghiêm trọng
          </span>
          <Badge variant="secondary" className="tnum font-mono text-[10px]">
            {visible.length}/{anomalies.length}
          </Badge>
        </div>
        <ToggleGroup
          multiple
          value={severities}
          onValueChange={(v) => onSeveritiesChange(v as Severity[])}
          spacing={2}
          className="w-full justify-start"
        >
          {SEVERITY_ORDER.map((s) => (
            <ToggleGroupItem
              key={s}
              value={s}
              size="sm"
              className="h-6.5 px-2 font-mono text-[10px] uppercase gap-1"
            >
              <span>{s.slice(0, 4)}</span>
              <span className="text-[9px] opacity-70 font-semibold">({counts[s]})</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <ul className="flex flex-col divide-y divide-border/30">
          {visible.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onSelect(a)}
                className={cn(
                  "flex w-full flex-col gap-1 border-l-2 px-3.5 py-2.5 text-left hover:bg-accent/40 transition-colors cursor-pointer",
                  a.id === selectedId ? "bg-accent/70 shadow-xs" : "border-l-transparent",
                )}
                style={a.id === selectedId ? { borderLeftColor: severityColor[a.severity] } : undefined}
              >
                <div className="flex items-center gap-1.5">
                  <SeverityBadge severity={a.severity} />
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
                    ⏱ {clock(relativeSpan(a).start, false)}
                  </span>
                </div>
                <span className="text-xs leading-snug font-medium text-pretty text-foreground">{a.title}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">{a.metric}</span>
                <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground mt-0.5">
                  <span className="truncate max-w-[160px] text-primary">{a.topics[0]}</span>
                  <span className="ml-auto shrink-0 font-semibold">conf {(a.confidence * 100).toFixed(0)}%</span>
                </div>
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="p-8 text-center text-xs text-muted-foreground font-mono">
              Không có sự cố nào khớp với bộ lọc
            </li>
          )}
        </ul>
      </ScrollArea>
    </div>
  )
}
