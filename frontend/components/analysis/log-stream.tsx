"use client"

import { useEffect, useMemo, useRef } from "react"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { clock, levelText } from "@/lib/api"
import type { LogEvent, LogLevel } from "@/lib/types"
import { cn } from "@/lib/utils"

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "fatal"]

/**
 * Log console for the active window. Rows are keyed to the playhead so
 * scrubbing the timeline auto-follows the nearest log line.
 */
export function LogStream({
  logs,
  playhead,
  levels,
  query,
  follow,
  onLevelsChange,
  onQueryChange,
  onSeek,
}: {
  logs: LogEvent[]
  playhead: number
  levels: LogLevel[]
  query: string
  follow: boolean
  onLevelsChange: (levels: LogLevel[]) => void
  onQueryChange: (q: string) => void
  onSeek: (t: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs.filter((l) => {
      if (levels.length && !levels.includes(l.level)) return false
      if (q && !l.message.toLowerCase().includes(q) && !l.node.toLowerCase().includes(q)) return false
      return true
    })
  }, [logs, levels, query])

  // Index of the last line at or before the playhead — the "you are here" row.
  const activeIndex = useMemo(() => {
    let idx = -1
    for (let i = 0; i < filtered.length; i++) {
      if (filtered[i].tSec <= playhead) idx = i
      else break
    }
    return idx
  }, [filtered, playhead])

  useEffect(() => {
    if (!follow || activeIndex < 0) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIndex}"]`)
    row?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, follow])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 px-3">
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="lọc node hoặc tin nhắn…"
          className="h-7 max-w-[220px] font-mono text-xs"
          aria-label="Lọc dòng nhật ký"
        />
        <ToggleGroup
          multiple
          value={levels}
          onValueChange={(v) => onLevelsChange(v as LogLevel[])}
          spacing={2}
          className="ml-auto"
        >
          {LEVELS.map((l) => (
            <ToggleGroupItem key={l} value={l} size="sm" className="h-7 px-2 font-mono text-[10px] uppercase">
              {l}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Badge variant="secondary" className="tnum font-mono text-[10px]">
          {filtered.length} dòng
        </Badge>
      </div>

      {filtered.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle className="text-sm">Không có dòng nhật ký khớp</EmptyTitle>
            <EmptyDescription className="text-xs">
              Mở rộng cửa sổ thời gian, xóa bộ lọc, hoặc bật lại mức nghiêm trọng.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div ref={listRef} className="flex flex-col pb-2">
            {filtered.map((l, i) => (
              <button
                key={l.id}
                data-row={i}
                type="button"
                onClick={() => onSeek(l.tSec)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-[3px] text-left font-mono text-[11px] leading-4 hover:bg-accent/60",
                  i === activeIndex && "bg-primary/10 ring-1 ring-inset ring-primary/40",
                )}
              >
                <span className="w-[58px] shrink-0 tabular-nums text-muted-foreground">{clock(l.tSec)}</span>
                <span className={cn("w-[38px] shrink-0 uppercase", levelText[l.level])}>{l.level}</span>
                <span className="w-[128px] shrink-0 truncate text-muted-foreground">{l.node}</span>
                <span className="min-w-0 flex-1 text-foreground/90">{l.message}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
