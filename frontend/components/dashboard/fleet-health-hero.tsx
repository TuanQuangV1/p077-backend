"use client"

import React from "react"
import {
  BotIcon,
  PlayCircleIcon,
  UploadIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HealthGauge } from "@/components/health/health-gauge"
import { cn } from "@/lib/utils"
import type { HealthStatus } from "@/lib/types"

interface FleetHealthHeroProps {
  healthScore?: { score: number; status: string } | null
  totals?: Record<string, number>
  navigate: (href: string) => void
}

export function FleetHealthHero({
  healthScore,
  totals = {},
  navigate,
}: FleetHealthHeroProps) {
  const score = healthScore?.score ?? 85
  const status = (healthScore?.status as HealthStatus) || "green"

  const statusColor =
    status === "green"
      ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
      : status === "yellow"
      ? "text-amber-400 border-amber-500/30 bg-amber-500/10"
      : "text-rose-400 border-rose-500/30 bg-rose-500/10"

  const statusText =
    status === "green"
      ? "Nominal Operations"
      : status === "yellow"
      ? "Degraded Performance"
      : "Critical Faults"

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-gradient-to-r from-card/90 via-card/60 to-primary/5 p-5 shadow-lg backdrop-blur-md">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        {/* Left: Health Gauge & Fleet Summary */}
        <div className="flex flex-wrap items-center gap-5">
          <div className="shrink-0 flex items-center justify-center p-1 rounded-xl bg-background/50 border border-border/50">
            <HealthGauge score={score} status={status} size="sm" />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn("font-medium text-xs px-2.5 py-0.5", statusColor)}>
                <span className="mr-1.5 size-2 rounded-full bg-current animate-pulse inline-block" />
                {statusText}
              </Badge>
              <span className="text-xs font-mono text-muted-foreground hidden sm:inline">
                · ROS2 Doctor + LLM Agent Engine
              </span>
            </div>
            <h2 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">
              Autonomous Robotics Diagnostics & Telemetry Hub
            </h2>
            <p className="text-xs text-muted-foreground max-w-xl leading-relaxed">
              Automated anomaly triage across ROSBag2 SQLite3/MCAP streams — detects topic frequency drops, timestamp jitter, sensor dropouts, and synthesizes root-cause analyses via specialized LLM agents.
            </p>
          </div>
        </div>

        {/* Right: Quick Action Shortcuts */}
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <Button
            size="sm"
            onClick={() => navigate("/datasets")}
            className="bg-primary text-primary-foreground shadow hover:bg-primary/90 font-medium cursor-pointer"
          >
            <UploadIcon data-icon="inline-start" className="size-4 mr-1.5" />
            Upload ROSBag
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/analysis")}
            className="border-border/80 hover:bg-accent/60 cursor-pointer"
          >
            <PlayCircleIcon data-icon="inline-start" className="size-4 mr-1.5 text-cyan-400" />
            Open Workspace
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/review")}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <BotIcon data-icon="inline-start" className="size-4 mr-1.5 text-purple-400" />
            Review Queue ({totals.reviewPending ?? totals.anomalies ?? 0})
          </Button>
        </div>
      </div>
    </div>
  )
}
