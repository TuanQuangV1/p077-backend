"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { clock } from "@/lib/api"
import type { Anomaly, Severity } from "@/lib/types"
import { cn } from "@/lib/utils"

export interface Lane {
  topic: string
  messageType: string
  expectedHz: number
  hz: number
  density: number[]
}

const ROW_H = 22
const AXIS_H = 24

/** Reads a CSS custom property off a live element so canvas matches the theme. */
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * Message-density timeline.
 *
 * Drawn on canvas rather than SVG because a real bag has ~20 topics x 240
 * buckets x anomaly bands, and re-rendering that as DOM nodes on every scrub
 * frame drops frames. One canvas repaint keeps scrubbing at 60fps.
 *
 * Interactions: drag to scrub, wheel to zoom about the cursor, shift+drag to
 * pan, double-click to reset the view.
 */
export function TimelineCanvas({
  durationSec,
  lanes,
  anomalies,
  playhead,
  view,
  selectedAnomalyId,
  onScrub,
  onViewChange,
  onSelectAnomaly,
}: {
  durationSec: number
  lanes: Lane[]
  anomalies: Anomaly[]
  playhead: number
  view: { from: number; to: number }
  selectedAnomalyId: string | null
  onScrub: (t: number) => void
  onViewChange: (v: { from: number; to: number }) => void
  onSelectAnomaly: (id: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null)
  const dragRef = useRef<null | "scrub" | "pan">(null)
  const panRef = useRef<{ x: number; from: number; to: number }>({ x: 0, from: 0, to: 0 })

  const height = AXIS_H + lanes.length * ROW_H + 6
  const span = Math.max(view.to - view.from, 0.05)

  const laneMax = useMemo(() => lanes.map((l) => Math.max(1, ...l.density)), [lanes])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const xOf = useCallback((t: number) => ((t - view.from) / span) * width, [view.from, span, width])
  const tOf = useCallback((x: number) => view.from + (x / Math.max(width, 1)) * span, [view.from, span, width])

  /* ---------- paint ---------- */
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || width === 0) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const c = {
      grid: cssVar(wrap, "--grid-line", "rgba(255,255,255,0.07)"),
      muted: cssVar(wrap, "--muted-foreground", "#9aa4ad"),
      primary: cssVar(wrap, "--primary", "#4fd1e0"),
      fg: cssVar(wrap, "--foreground", "#f2f4f6"),
      sev: {
        critical: cssVar(wrap, "--severity-critical", "#e0483c"),
        high: cssVar(wrap, "--severity-high", "#e8823a"),
        medium: cssVar(wrap, "--severity-medium", "#e8b13a"),
        low: cssVar(wrap, "--severity-low", "#7fa8c9"),
      } as Record<Severity, string>,
    }

    /* time grid + axis labels */
    const targetTicks = Math.max(3, Math.floor(width / 92))
    const raw = span / targetTicks
    const pow = Math.pow(10, Math.floor(Math.log10(raw)))
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow

    ctx.font = "10px ui-monospace, monospace"
    ctx.textBaseline = "middle"
    for (let t = Math.ceil(view.from / step) * step; t <= view.to; t += step) {
      const x = Math.round(xOf(t)) + 0.5
      ctx.strokeStyle = c.grid
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, AXIS_H)
      ctx.lineTo(x, height)
      ctx.stroke()
      ctx.fillStyle = c.muted
      ctx.fillText(clock(t, span < 12), x + 4, AXIS_H / 2)
    }

    /* anomaly bands behind the lanes */
    for (const a of anomalies) {
      const x0 = xOf(a.tSec)
      const x1 = Math.max(xOf(a.endSec), x0 + 2)
      if (x1 < 0 || x0 > width) continue
      ctx.globalAlpha = a.id === selectedAnomalyId ? 0.3 : 0.14
      ctx.fillStyle = c.sev[a.severity]
      ctx.fillRect(x0, AXIS_H, x1 - x0, height - AXIS_H)
      ctx.globalAlpha = 1
      ctx.fillStyle = c.sev[a.severity]
      ctx.fillRect(x0, AXIS_H - 3, Math.max(x1 - x0, 2), 3)
      if (a.id === selectedAnomalyId) {
        ctx.strokeStyle = c.sev[a.severity]
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x0) + 0.5, AXIS_H + 0.5, Math.max(x1 - x0, 2), height - AXIS_H - 1)
      }
    }

    /* density bars per topic lane */
    const buckets = lanes[0]?.density.length ?? 1
    lanes.forEach((lane, i) => {
      const top = AXIS_H + i * ROW_H
      if (i % 2 === 1) {
        ctx.fillStyle = c.grid
        ctx.globalAlpha = 0.45
        ctx.fillRect(0, top, width, ROW_H)
        ctx.globalAlpha = 1
      }
      const inner = ROW_H - 6
      const max = laneMax[i]
      const degraded = lane.hz < lane.expectedHz * 0.9

      for (let x = 0; x < width; x++) {
        const t = tOf(x)
        if (t < 0 || t > durationSec) continue
        const b = Math.min(buckets - 1, Math.max(0, Math.floor((t / durationSec) * buckets)))
        const v = lane.density[b] / max
        const h = Math.max(1, v * inner)
        ctx.fillStyle = degraded && v < 0.4 ? c.sev.medium : c.primary
        ctx.globalAlpha = 0.25 + v * 0.65
        ctx.fillRect(x, top + 3 + (inner - h), 1, h)
      }
      ctx.globalAlpha = 1
    })

    /* hover crosshair */
    if (hover) {
      const x = Math.round(hover.x) + 0.5
      ctx.strokeStyle = c.muted
      ctx.globalAlpha = 0.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, AXIS_H)
      ctx.lineTo(x, height)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    /* playhead */
    const px = Math.round(xOf(playhead)) + 0.5
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = c.fg
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(px, AXIS_H - 6)
      ctx.lineTo(px, height)
      ctx.stroke()
      ctx.fillStyle = c.fg
      ctx.beginPath()
      ctx.moveTo(px - 4, AXIS_H - 10)
      ctx.lineTo(px + 4, AXIS_H - 10)
      ctx.lineTo(px, AXIS_H - 3)
      ctx.closePath()
      ctx.fill()
    }
  }, [
    width,
    height,
    lanes,
    laneMax,
    anomalies,
    playhead,
    view.from,
    view.to,
    span,
    durationSec,
    hover,
    selectedAnomalyId,
    xOf,
    tOf,
  ])

  /* ---------- interaction ---------- */
  const localX = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return e.clientX - rect.left
  }

  const clampT = (t: number) => Math.min(durationSec, Math.max(0, t))

  const onDown = (e: React.MouseEvent) => {
    const x = localX(e)
    const t = clampT(tOf(x))
    if (e.shiftKey) {
      dragRef.current = "pan"
      panRef.current = { x, from: view.from, to: view.to }
      return
    }
    dragRef.current = "scrub"
    onScrub(t)
    // clicking a band also selects it, so the inspector follows the timeline
    const hit = anomalies.find((a) => t >= a.tSec && t <= a.endSec)
    if (hit) onSelectAnomaly(hit.id)
  }

  const onMove = (e: React.MouseEvent) => {
    const x = localX(e)
    setHover({ x, t: tOf(x) })
    if (dragRef.current === "scrub") onScrub(clampT(tOf(x)))
    else if (dragRef.current === "pan") {
      const dt = ((panRef.current.x - x) / Math.max(width, 1)) * span
      let from = panRef.current.from + dt
      let to = panRef.current.to + dt
      if (from < 0) {
        to -= from
        from = 0
      }
      if (to > durationSec) {
        from -= to - durationSec
        to = durationSec
      }
      onViewChange({ from: Math.max(0, from), to: Math.min(durationSec, to) })
    }
  }

  const endDrag = () => {
    dragRef.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const x = localX(e)
    const anchor = tOf(x)
    const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18
    const newSpan = Math.min(durationSec, Math.max(0.5, span * factor))
    const ratio = x / Math.max(width, 1)
    let from = anchor - ratio * newSpan
    let to = from + newSpan
    if (from < 0) {
      from = 0
      to = newSpan
    }
    if (to > durationSec) {
      to = durationSec
      from = Math.max(0, to - newSpan)
    }
    onViewChange({ from, to })
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0">
        {/* Topic gutter stays in the DOM so labels are selectable + screen-readable. */}
        <div className="w-[168px] shrink-0 border-r border-border" style={{ paddingTop: AXIS_H }}>
          {lanes.map((lane) => {
            const degraded = lane.hz < lane.expectedHz * 0.9
            return (
              <div
                key={lane.topic}
                className="flex items-center gap-1.5 pr-2 pl-3"
                style={{ height: ROW_H }}
                title={`${lane.topic} · ${lane.messageType} · ${lane.hz}Hz of ${lane.expectedHz}Hz`}
              >
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", degraded ? "bg-medium" : "bg-primary/60")}
                  aria-hidden
                />
                <span className="truncate font-mono text-[11px] text-foreground/85">{lane.topic}</span>
                <span className={cn("ml-auto shrink-0 font-mono text-[10px]", degraded ? "text-medium" : "text-muted-foreground")}>
                  {lane.hz}
                </span>
              </div>
            )
          })}
        </div>

        <div
          ref={wrapRef}
          className="relative min-w-0 flex-1 cursor-crosshair select-none"
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={endDrag}
          onMouseLeave={() => {
            endDrag()
            setHover(null)
          }}
          onWheel={onWheel}
          onDoubleClick={() => onViewChange({ from: 0, to: durationSec })}
          role="slider"
          tabIndex={0}
          aria-label="Run timeline scrubber"
          aria-valuemin={0}
          aria-valuemax={durationSec}
          aria-valuenow={Number(playhead.toFixed(2))}
          aria-valuetext={`${clock(playhead)} of ${clock(durationSec)}`}
          onKeyDown={(e) => {
            const fine = e.shiftKey ? 0.05 : 0.5
            if (e.key === "ArrowRight") onScrub(clampT(playhead + fine))
            if (e.key === "ArrowLeft") onScrub(clampT(playhead - fine))
            if (e.key === "Home") onScrub(0)
            if (e.key === "End") onScrub(durationSec)
          }}
        >
          <canvas ref={canvasRef} className="block" />
          {hover ? (
            <div
              className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded border border-border bg-popover px-1.5 py-0.5 font-mono text-[10px] text-popover-foreground shadow-sm"
              style={{ left: Math.min(Math.max(hover.x, 28), width - 28) }}
            >
              {clock(hover.t)}
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-2 px-3 font-mono text-[10px] text-muted-foreground">
        drag scrub · wheel zoom · shift+drag pan · dblclick reset · window {clock(view.from)}–{clock(view.to)}
      </p>
    </div>
  )
}
