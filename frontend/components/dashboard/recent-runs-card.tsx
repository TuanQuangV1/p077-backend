"use client"

import React from "react"
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ClockIcon,
  DatabaseIcon,
  FileTextIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { StatusLabel } from "@/components/telemetry"
import { cn } from "@/lib/utils"
import type { AnalysisRun } from "@/lib/types"

interface RecentRunsCardProps {
  runs: AnalysisRun[]
  navigate: (href: string) => void
}

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return "--"
  try {
    const d = new Date(dateStr)
    const now = new Date()
    const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000)
    if (diffSec < 60) return "vừa xong"
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`
    return d.toLocaleDateString("vi-VN", { month: "numeric", day: "numeric" })
  } catch {
    return dateStr
  }
}

export function RecentRunsCard({ runs = [], navigate }: RecentRunsCardProps) {
  if (!runs || runs.length === 0) {
    return (
      <div className="flex h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
        <FileTextIcon className="size-5 opacity-40" />
        <p>Chưa có lượt chẩn đoán rosbag nào được thực hiện.</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/datasets")}>
          Nạp tập dữ liệu ngay
        </Button>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        {/* Table Header */}
        <thead>
          <tr className="border-b border-border/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <th className="pb-2.5 pt-1 font-medium">Trạng thái</th>
            <th className="pb-2.5 pt-1 font-medium">Tập tin Rosbag</th>
            <th className="pb-2.5 pt-1 font-medium hidden sm:table-cell">Loại robot</th>
            <th className="pb-2.5 pt-1 font-medium">Bất thường</th>
            <th className="pb-2.5 pt-1 font-medium">Mức độ nghiêm trọng</th>
            <th className="pb-2.5 pt-1 font-medium hidden md:table-cell text-right">Thời lượng</th>
            <th className="pb-2.5 pt-1 font-medium hidden lg:table-cell text-right">Thời điểm</th>
            <th className="pb-2.5 pt-1 font-medium text-right pr-2">Thao tác</th>
          </tr>
        </thead>

        {/* Table Body */}
        <tbody className="divide-y divide-border/40 font-mono">
          {runs.map((run) => {
            const isCritical = run.worstSeverity === "critical"
            const isHigh = run.worstSeverity === "high"
            const isMedium = run.worstSeverity === "medium"
            const isClean = run.anomalyCount === 0

            return (
              <tr
                key={run.id}
                onClick={() => navigate("/analysis")}
                className="group transition-colors hover:bg-accent/40 cursor-pointer"
              >
                {/* 1. Status */}
                <td className="py-3 font-sans">
                  <StatusLabel status={run.status} />
                </td>

                {/* 2. File Name */}
                <td className="py-3 pr-3">
                  <div className="flex items-center gap-1.5 font-sans font-semibold text-foreground group-hover:text-primary transition-colors">
                    <DatabaseIcon className="size-3.5 text-muted-foreground/70 shrink-0 hidden sm:inline" />
                    <span className="truncate max-w-[180px] lg:max-w-none">{run.rosbagName}</span>
                  </div>
                </td>

                {/* 3. Robot Type */}
                <td className="py-3 pr-3 hidden sm:table-cell font-sans">
                  {run.robotType ? (
                    <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground border border-border/40">
                      {run.robotType}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/50">--</span>
                  )}
                </td>

                {/* 4. Anomaly Count Column */}
                <td className="py-3 pr-3">
                  {isClean ? (
                    <span className="font-mono text-xs font-semibold text-emerald-400">0</span>
                  ) : (
                    <span className="font-mono text-xs font-bold text-foreground">
                      {run.anomalyCount}{" "}
                      <span className="font-sans text-[11px] font-normal text-muted-foreground">sự cố</span>
                    </span>
                  )}
                </td>

                {/* 5. Severity Tag Column (Aligned with the Severity chart) */}
                <td className="py-3 pr-3 font-sans">
                  {isClean ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      <CheckCircle2Icon className="size-3 shrink-0" />
                      Bình thường
                    </span>
                  ) : isCritical ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-400">
                      <span className="size-1.5 rounded-full bg-rose-500" />
                      Nghiêm trọng
                    </span>
                  ) : isHigh ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium text-orange-400">
                      <span className="size-1.5 rounded-full bg-orange-500" />
                      Cao
                    </span>
                  ) : isMedium ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                      <span className="size-1.5 rounded-full bg-amber-500" />
                      Trung bình
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-500/30 bg-slate-500/10 px-2 py-0.5 text-[11px] font-medium text-slate-400">
                      <span className="size-1.5 rounded-full bg-slate-400" />
                      Thấp
                    </span>
                  )}
                </td>

                {/* 6. Latency / Duration */}
                <td className="py-3 pr-3 hidden md:table-cell text-right text-muted-foreground">
                  {run.totalLatencyMs ? `${(run.totalLatencyMs / 1000).toFixed(1)}s` : "--"}
                </td>

                {/* 7. Timestamp */}
                <td className="py-3 pr-3 hidden lg:table-cell text-right text-muted-foreground font-sans text-xs">
                  {formatRelativeTime(run.finishedAt || run.startedAt)}
                </td>

                {/* 8. Action Link */}
                <td className="py-3 text-right pr-2 font-sans">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-primary opacity-80 group-hover:opacity-100 group-hover:underline">
                    Xem chẩn đoán <ArrowRightIcon className="size-3 ml-0.5 inline-block group-hover:translate-x-0.5 transition-transform" />
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
