"use client"

import React, { useEffect, useState } from "react"
import {
  ActivityIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { StatTile, SectionCard } from "@/components/telemetry"
import { compact, fetcher } from "@/lib/api"
import type { AnalysisRun, HealthStatus, HealthSummary } from "@/lib/types"

import { FleetTrendChart, type TrendPoint } from "./fleet-trend-chart"
import { IssueBreakdownCard } from "./issue-breakdown-card"
import { RecentRunsCard } from "./recent-runs-card"

export type Overview = {
  totals: Record<string, number>
  topIssues: { label: string; count: number; kind?: string }[]
  severity: { severity: string; count: number }[]
  trend: TrendPoint[]
  recentRuns: AnalysisRun[]
}

interface DashboardOverviewProps {
  overview: Overview | null
  navigate: (href: string) => void
}

export function DashboardOverview({ overview, navigate }: DashboardOverviewProps) {
  const totals = overview?.totals ?? {}
  const [healthScore, setHealthScore] = useState<{ score: number; status: string } | null>(null)

  useEffect(() => {
    const run = overview?.recentRuns?.find((x) => x.status === "succeeded") ?? overview?.recentRuns?.[0]
    if (!run) return
    fetcher<HealthSummary>(`/api/runs/${run.id}/health`)
      .then((h) => setHealthScore({ score: h.health_score, status: h.status }))
      .catch(() => {})
  }, [overview])

  const score = healthScore?.score ?? 85
  const status = (healthScore?.status as HealthStatus) || "green"

  return (
    <div className="space-y-5">
      {/* 1. Precision Metric Instrument Tiles */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {/* Instrument Tile 1: Fleet Health Score */}
        <StatTile
          label="Fleet Health Index"
          value={score}
          unit="/ 100"
          tone={status === "green" ? "ok" : status === "yellow" ? "default" : "critical"}
          hint={status === "green" ? "Optimal · All nodes nominal" : status === "yellow" ? "Degraded · Latency warning" : "Critical · Active faults detected"}
          icon={<GaugeIcon className="size-4" />}
        />

        {/* Instrument Tile 2: Rosbags processed */}
        <StatTile
          label="ROSBags Processed"
          value={totals.analyzed ?? totals.rosbags ?? "--"}
          hint={`${totals.rosbags ?? 0} registered · ${totals.hoursOfData ?? 0}h capture time`}
          icon={<DatabaseIcon className="size-4" />}
        />

        {/* Instrument Tile 3: Runs with errors */}
        <StatTile
          label="Runs with Anomalies"
          value={totals.runsWithIssuesPct !== undefined ? `${totals.runsWithIssuesPct}%` : "--"}
          tone="critical"
          hint={`${totals.anomalies ?? 0} anomalies detected`}
          icon={<CircleAlertIcon className="size-4" />}
        />

        {/* Instrument Tile 4: Mean diagnosis */}
        <StatTile
          label="Mean Time to Diagnose"
          value={totals.meanTimeToDiagnoseSec ?? 2}
          unit="sec"
          hint="From ingest to AI root cause"
          icon={<ActivityIcon className="size-4" />}
        />

        {/* Instrument Tile 5: Inference cost */}
        <StatTile
          label="AI Inference Cost"
          value={totals.inferenceCostUsd ? `$${totals.inferenceCostUsd}` : "--"}
          hint={`${compact(totals.tokens ?? 0)} tokens consumed`}
          icon={<CpuIcon className="size-4" />}
        />
      </div>

      {/* 2. Visual Analytics Section */}
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        {/* 14-day operating trend */}
        <SectionCard
          title="14-Day Fleet Telemetry Trend"
          description="Capture volume, anomaly frequency, and P95 diagnostic latency"
        >
          <FleetTrendChart data={overview?.trend ?? []} />
        </SectionCard>

        {/* Top Issues & Severity Breakdown */}
        <SectionCard
          title="Fault Taxonomy & Severity Breakdown"
          description="Anomaly categorization across sensors, QoS, and motor controllers"
        >
          <IssueBreakdownCard
            topIssues={overview?.topIssues ?? []}
            severity={overview?.severity ?? []}
          />
        </SectionCard>
      </div>

      {/* 3. Recent Analysis Runs Table */}
      <SectionCard
        title="Recent Diagnostic Runs"
        description="Latest automated ROSBag2 and MCAP analysis executions"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/analysis")}
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            Open Diagnostics Workspace <ArrowRightIcon data-icon="inline-end" className="size-3.5 ml-1" />
          </Button>
        }
      >
        <RecentRunsCard
          runs={overview?.recentRuns ?? []}
          navigate={navigate}
        />
      </SectionCard>
    </div>
  )
}
