"use client"

import React, { useEffect, useState } from "react"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  LayersIcon,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatTile, SectionCard } from "@/components/telemetry"
import { HealthGauge } from "@/components/health/health-gauge"
import { compact, fetcher, ms } from "@/lib/api"
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
          label="Chỉ số sức khỏe hạm đội"
          value={score}
          unit="/ 100"
          tone={status === "green" ? "ok" : status === "yellow" ? "default" : "critical"}
          hint={status === "green" ? "Khỏe mạnh · Vận hành bình thường" : status === "yellow" ? "Cảnh báo · Hiệu năng suy giảm" : "Sự cố · Có lỗi nghiêm trọng"}
          icon={<GaugeIcon className="size-4" />}
        />

        {/* Instrument Tile 2: Rosbags processed */}
        <StatTile
          label="Tệp rosbag đã xử lý"
          value={totals.analyzed ?? totals.rosbags ?? "--"}
          hint={`${totals.rosbags ?? 0} đã đăng ký · ${totals.hoursOfData ?? 0}h dữ liệu`}
          icon={<DatabaseIcon className="size-4" />}
        />

        {/* Instrument Tile 3: Runs with errors */}
        <StatTile
          label="Lượt chạy có lỗi"
          value={totals.runsWithIssuesPct !== undefined ? `${totals.runsWithIssuesPct}%` : "--"}
          tone="critical"
          hint={`${totals.anomalies ?? 0} bất thường phát hiện`}
          icon={<CircleAlertIcon className="size-4" />}
        />

        {/* Instrument Tile 4: Mean diagnosis */}
        <StatTile
          label="Thời gian chẩn đoán trung bình"
          value={totals.meanTimeToDiagnoseSec ?? 2}
          unit="giây"
          hint="Từ nạp dữ liệu đến kết luận AI"
          icon={<ActivityIcon className="size-4" />}
        />

        {/* Instrument Tile 5: Inference cost */}
        <StatTile
          label="Chi phí suy luận AI"
          value={totals.inferenceCostUsd ? `$${totals.inferenceCostUsd}` : "--"}
          hint={`${compact(totals.tokens ?? 0)} tokens tiêu thụ`}
          icon={<CpuIcon className="size-4" />}
        />
      </div>

      {/* 2. Visual Analytics Section */}
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        {/* 14-day operating trend */}
        <SectionCard
          title="Xu hướng hoạt động 14 ngày"
          description="Lưu lượng ghi nhận dữ liệu, số lượng bất thường và độ trễ chẩn đoán P95"
        >
          <FleetTrendChart data={overview?.trend ?? []} />
        </SectionCard>

        {/* Top Issues & Severity Breakdown */}
        <SectionCard
          title="Phân loại sự cố & Mức độ nghiêm trọng"
          description="Phân bổ dạng lỗi bất thường và tỷ lệ severity"
        >
          <IssueBreakdownCard
            topIssues={overview?.topIssues ?? []}
            severity={overview?.severity ?? []}
          />
        </SectionCard>
      </div>

      {/* 3. Recent Analysis Runs Table */}
      <SectionCard
        title="Lượt phân tích gần đây"
        description="Danh sách các tác vụ chẩn đoán rosbag mới nhất"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/analysis")}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Mở không gian phân tích <ArrowRightIcon data-icon="inline-end" className="size-3.5 ml-1" />
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
