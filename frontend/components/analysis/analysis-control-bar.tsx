"use client"

import React, { useState, useRef } from "react"
import {
  ClockIcon,
  LayersIcon,
  SaveIcon,
  SlidersHorizontalIcon,
  ChevronDownIcon,
  CheckCircle2Icon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { AnalysisRun } from "@/lib/types"
import type { Lane } from "@/components/analysis/timeline-canvas"

interface AnalysisControlBarProps {
  activeRun: AnalysisRun | null
  lanes: Lane[]
  topicFilter: string
  setTopicFilter: (topic: string) => void
  timeRange: string
  setTimeRange: (range: string) => void
  onTimeRangeChange: (value: string) => void
  thresholds: Record<string, number>
  setThresholds: (thresholds: Record<string, number>) => void
  savingThresholds: boolean
  saveThresholds: () => void
}

export function AnalysisControlBar({
  activeRun,
  lanes = [],
  topicFilter,
  setTopicFilter,
  timeRange,
  setTimeRange,
  onTimeRangeChange,
  thresholds,
  setThresholds,
  savingThresholds,
  saveThresholds,
}: AnalysisControlBarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  const openMenu = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setIsOpen(true)
  }

  const closeMenu = () => {
    timerRef.current = setTimeout(() => {
      setIsOpen(false)
    }, 220)
  }

  const selectedTopicLabel =
    topicFilter === "all"
      ? `All Topics (${lanes.length})`
      : topicFilter

  const selectedTimeLabel =
    timeRange === "30"
      ? "First 30s"
      : timeRange === "60"
      ? "First 60s"
      : "Full Run"

  return (
    <div
      data-testid="thresholds-panel"
      className="relative z-30 flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-card/70 px-4 py-2 shadow-xs"
    >
      {/* Unified Single Button with Hover Popover */}
      <div
        className="relative inline-block group"
        onMouseEnter={openMenu}
        onMouseLeave={closeMenu}
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() => setIsOpen((prev) => !prev)}
          onMouseEnter={openMenu}
          className="h-8.5 gap-2.5 text-xs font-medium transition-all group-hover:bg-secondary group-hover:border-primary/40 cursor-pointer shadow-xs"
        >
          <SlidersHorizontalIcon className="size-3.5 text-primary" />
          <span className="font-semibold text-foreground">
            Filters & Diagnostic Controls
          </span>

          <div className="flex items-center gap-1.5 pl-1 text-[11px] text-muted-foreground border-l border-border/60">
            <span className="max-w-[120px] truncate font-mono text-[10px] text-foreground/80">
              {selectedTopicLabel}
            </span>
            <span>·</span>
            <span className="font-mono text-[10px] text-foreground/80">
              {selectedTimeLabel}
            </span>
          </div>

          <ChevronDownIcon
            className={cn(
              "size-3 text-muted-foreground transition-transform duration-200 group-hover:rotate-180",
              isOpen && "rotate-180"
            )}
          />
        </Button>

        {/* Floating Unified Popover on Hover / Click / Focus */}
        <div
          onMouseEnter={openMenu}
          onMouseLeave={closeMenu}
          className={cn(
            "absolute left-0 top-full z-50 mt-1.5 w-[380px] rounded-xl border border-border/90 bg-popover/95 p-4 shadow-2xl backdrop-blur-md transition-all duration-200 origin-top",
            "opacity-0 scale-95 -translate-y-1 pointer-events-none",
            "group-hover:opacity-100 group-hover:scale-100 group-hover:translate-y-0 group-hover:pointer-events-auto",
            "hover:opacity-100 hover:scale-100 hover:translate-y-0 hover:pointer-events-auto",
            "focus-within:opacity-100 focus-within:scale-100 focus-within:translate-y-0 focus-within:pointer-events-auto",
            isOpen && "!opacity-100 !scale-100 !translate-y-0 !pointer-events-auto"
          )}
        >
          <div className="space-y-4">
            {/* Popover Header */}
            <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
              <div className="flex items-center gap-2">
                <SlidersHorizontalIcon className="size-4 text-primary" />
                <span className="text-xs font-semibold text-foreground">
                  Diagnostic Scope & Sensitivity
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">
                Auto-dismiss on blur
              </span>
            </div>

            {/* Section 1: Filters (Topic & Time) */}
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-2.5">
              <div className="text-[11px] font-semibold text-foreground/90 flex items-center gap-1.5">
                <LayersIcon className="size-3.5 text-primary" />
                <span>1. Telemetry Scope</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {/* Topic Selector */}
                <div className="space-y-1">
                  <label className="text-[10px] font-medium text-muted-foreground">
                    ROS Topic Lane
                  </label>
                  <div className="relative flex items-center">
                    <select
                      value={topicFilter}
                      onChange={(e) => setTopicFilter(e.target.value)}
                      className="h-8 w-full rounded-md border border-border/80 bg-background pl-2 pr-4 font-sans text-[11px] font-medium text-foreground transition-colors hover:border-primary/50 focus:border-primary focus:outline-hidden cursor-pointer"
                    >
                      <option value="all">All Topics ({lanes.length})</option>
                      {lanes.map((lane) => (
                        <option key={lane.topic} value={lane.topic} className="font-mono text-xs">
                          {lane.topic}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Time Range Selector */}
                <div className="space-y-1">
                  <label className="text-[10px] font-medium text-muted-foreground flex items-center gap-1">
                    <ClockIcon className="size-2.5 text-primary" />
                    <span>Time Window</span>
                  </label>
                  <div className="relative flex items-center">
                    <select
                      value={timeRange}
                      onChange={(e) => onTimeRangeChange(e.target.value)}
                      className="h-8 w-full rounded-md border border-border/80 bg-background pl-2 pr-4 font-sans text-[11px] font-medium text-foreground transition-colors hover:border-primary/50 focus:border-primary focus:outline-hidden cursor-pointer"
                    >
                      <option value="all">Full ROSBag Run</option>
                      <option value="30">First 30 Seconds</option>
                      <option value="60">First 60 Seconds</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 2: Sensitivity & Thresholds */}
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-2.5">
              <div className="text-[11px] font-semibold text-foreground/90 flex items-center gap-1.5">
                <CheckCircle2Icon className="size-3.5 text-primary" />
                <span>2. Anomaly Detection Sensitivity</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {/* Max frequency gap */}
                <div className="space-y-1">
                  <label className="text-[10px] font-medium text-muted-foreground flex items-center justify-between">
                    <span>Frequency Gap Threshold</span>
                    <span className="font-mono text-[9px] text-muted-foreground">(sec)</span>
                  </label>
                  <div className="relative flex items-center">
                    <Input
                      data-testid="threshold-frequency-gap"
                      type="number"
                      min="0"
                      step="0.01"
                      value={thresholds.frequency_gap_min_threshold_sec ?? ""}
                      onChange={(event) =>
                        setThresholds({
                          ...thresholds,
                          frequency_gap_min_threshold_sec: Number(event.target.value),
                        })
                      }
                      className="h-8 w-full font-mono text-xs pr-5"
                    />
                    <span className="absolute right-2 text-[10px] text-muted-foreground font-mono">s</span>
                  </div>
                </div>

                {/* Silent node span */}
                <div className="space-y-1">
                  <label className="text-[10px] font-medium text-muted-foreground flex items-center justify-between">
                    <span>Silent Node Timeout</span>
                    <span className="font-mono text-[9px] text-muted-foreground">(sec)</span>
                  </label>
                  <div className="relative flex items-center">
                    <Input
                      type="number"
                      min="0"
                      step="0.1"
                      value={thresholds.silent_node_min_span_sec ?? ""}
                      onChange={(event) =>
                        setThresholds({
                          ...thresholds,
                          silent_node_min_span_sec: Number(event.target.value),
                        })
                      }
                      className="h-8 w-full font-mono text-xs pr-5"
                    />
                    <span className="absolute right-2 text-[10px] text-muted-foreground font-mono">s</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer Action */}
            <div className="border-t border-border/60 pt-2 flex justify-end">
              <Button
                data-testid="save-thresholds"
                size="sm"
                disabled={savingThresholds || Object.keys(thresholds).length === 0}
                onClick={saveThresholds}
                className="h-8 w-full gap-1.5 text-xs font-medium text-primary-foreground cursor-pointer shadow-xs"
              >
                <SaveIcon className="size-3.5" />
                {savingThresholds ? "Saving..." : "Save Threshold Configuration"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Right: Engine status */}
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className="font-mono text-[11px] text-muted-foreground bg-muted/30 border-border px-2.5 py-1"
        >
          <span className="size-1.5 rounded-full bg-ok mr-1.5 inline-block" />
          {activeRun?.stage ?? "done"} · {activeRun?.progress ?? 100}% · {lanes.length} lanes
        </Badge>
      </div>
    </div>
  )
}
