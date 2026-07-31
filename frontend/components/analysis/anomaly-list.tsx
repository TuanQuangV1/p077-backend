"use client"

import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SeverityBadge } from "@/components/telemetry"
import { clock, SEVERITY_ORDER, severityColor } from "@/lib/api"
import type { Anomaly, Severity } from "@/lib/types"
import { cn } from "@/lib/utils"

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

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Detections
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
        >
          {SEVERITY_ORDER.map((s) => (
            <ToggleGroupItem key={s} value={s} size="sm" className="h-6 px-1.5 font-mono text-[10px] uppercase">
              {s.slice(0, 4)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col">
          {visible.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onSelect(a)}
                className={cn(
                  "flex w-full flex-col gap-1 border-l-2 px-3 py-2 text-left hover:bg-accent/50",
                  a.id === selectedId ? "bg-accent/70" : "border-l-transparent",
                )}
                style={a.id === selectedId ? { borderLeftColor: severityColor[a.severity] } : undefined}
              >
                <div className="flex items-center gap-1.5">
                  <SeverityBadge severity={a.severity} />
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
                    {clock(a.tSec, false)}
                  </span>
                </div>
                <span className="text-xs leading-snug font-medium text-pretty">{a.title}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">{a.metric}</span>
                <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                  <span className="truncate">{a.topics[0]}</span>
                  <span className="ml-auto shrink-0">conf {(a.confidence * 100).toFixed(0)}%</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  )
}
