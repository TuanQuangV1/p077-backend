"use client"

import React from "react"
import { cn } from "@/lib/utils"

interface TopIssue {
  label: string
  count: number
  kind?: string
}

interface SeverityItem {
  severity: string
  count: number
}

interface IssueBreakdownCardProps {
  topIssues: TopIssue[]
  severity: SeverityItem[]
}

const ISSUE_LABEL_VI: Record<string, string> = {
  "Severe rate drop": "Sụt giảm tần số nghiêm trọng",
  "Topic rate drop": "Sụt giảm tần số topic",
  "Publish rate drop": "Sụt giảm tốc độ publish",
  "Silent node": "Node im lặng (mất kết nối)",
  "Message drop burst": "Mất gói tin nhắn liên tiếp",
  "Timestamp jitter": "Biến thiên nhịp thời gian",
  "QoS mismatch": "Xung đột cấu hình QoS",
}

const SEVERITY_DOT: Record<string, { label: string; dot: string; text: string }> = {
  critical: {
    label: "Nghiêm trọng",
    dot: "bg-rose-500",
    text: "text-rose-400",
  },
  high: {
    label: "Cao",
    dot: "bg-orange-500",
    text: "text-orange-400",
  },
  medium: {
    label: "Trung bình",
    dot: "bg-amber-500",
    text: "text-amber-400",
  },
  low: {
    label: "Thấp",
    dot: "bg-slate-400",
    text: "text-slate-400",
  },
}

export function IssueBreakdownCard({ topIssues = [], severity = [] }: IssueBreakdownCardProps) {
  const totalSeverityCount = severity.reduce((acc, curr) => acc + curr.count, 0) || 1
  const maxIssueCount = topIssues.length > 0 ? Math.max(...topIssues.map((i) => i.count), 1) : 1

  return (
    <div className="space-y-5">
      {/* 1. Top Issue Types */}
      <div className="space-y-3">
        <div className="flex items-center justify-between border-b border-border/40 pb-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Phân loại lỗi phổ biến
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {topIssues.length} dạng lỗi
          </span>
        </div>

        <div className="space-y-3">
          {topIssues.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">Chưa ghi nhận bất thường nào.</p>
          ) : (
            topIssues.slice(0, 5).map((issue) => {
              const pct = Math.round((issue.count / maxIssueCount) * 100)
              const viLabel = ISSUE_LABEL_VI[issue.label] ?? issue.label

              return (
                <div key={issue.label} className="group space-y-1.5 text-xs">
                  <div className="flex items-center justify-between font-mono">
                    <span className="font-sans font-medium text-foreground truncate max-w-[220px]" title={viLabel}>
                      {viLabel}
                    </span>
                    <span className="text-muted-foreground">
                      <strong className="text-foreground font-semibold">{issue.count}</strong>
                      <span className="text-[10px] ml-1 opacity-70">({Math.round((issue.count / totalSeverityCount) * 100)}%)</span>
                    </span>
                  </div>
                  {/* Clean, authentic solid bar without loud rainbow gradients */}
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/70 transition-all duration-300 group-hover:bg-primary"
                      style={{ width: `${Math.max(4, pct)}%` }}
                    />
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* 2. Severity Breakdown */}
      <div className="space-y-3 border-t border-border/50 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Mức độ nghiêm trọng
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {totalSeverityCount} tổng số
          </span>
        </div>

        {/* Multi-segment distribution bar */}
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {severity.map((item) => {
            const widthPct = (item.count / totalSeverityCount) * 100
            if (widthPct <= 0) return null
            const bgClass =
              item.severity === "critical"
                ? "bg-rose-500"
                : item.severity === "high"
                ? "bg-orange-500"
                : item.severity === "medium"
                ? "bg-amber-500"
                : "bg-slate-400"
            return (
              <div
                key={item.severity}
                className={cn("h-full transition-all duration-300", bgClass)}
                style={{ width: `${widthPct}%` }}
                title={`${item.severity}: ${item.count} (${widthPct.toFixed(1)}%)`}
              />
            )
          })}
        </div>

        {/* Clean, minimalist severity metrics list */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          {severity.map((item) => {
            const key = item.severity.toLowerCase()
            const conf = SEVERITY_DOT[key] || {
              label: item.severity,
              dot: "bg-slate-400",
              text: "text-muted-foreground",
            }
            const pct = Math.round((item.count / totalSeverityCount) * 100)

            return (
              <div
                key={item.severity}
                className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-muted/20 p-2 text-xs"
              >
                <div className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full shrink-0", conf.dot)} />
                  <span className="text-[11px] text-muted-foreground font-medium truncate">
                    {conf.label}
                  </span>
                </div>
                <div className="flex items-baseline gap-1 font-mono pl-3.5">
                  <span className="text-sm font-semibold text-foreground">{item.count}</span>
                  <span className="text-[10px] text-muted-foreground">({pct}%)</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
