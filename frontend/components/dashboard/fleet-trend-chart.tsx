"use client"

import React from "react"
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  type TooltipContentProps,
} from "recharts"

export interface TrendPoint {
  date: string
  bags: number
  anomalies: number
  p95Ms: number
  costUsd: number
}

interface FleetTrendChartProps {
  data: TrendPoint[]
}

function formatDateLabel(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  } catch {
    return dateStr
  }
}

const CustomTooltip = ({
  active,
  payload,
  label,
}: Partial<TooltipContentProps<number, string>>) => {
  if (!active || !payload || !payload.length) return null

  const dataPoint = payload[0]?.payload as TrendPoint | undefined

  return (
    <div className="rounded-xl border border-border/80 bg-popover/95 p-3 shadow-2xl backdrop-blur-md">
      <div className="border-b border-border/50 pb-1.5 mb-2 flex items-center justify-between gap-4">
        <span className="font-mono text-xs font-semibold text-foreground">
          {dataPoint?.date || label}
        </span>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono">
          Telemetry Snapshot
        </span>
      </div>
      <div className="space-y-1.5 text-xs font-mono">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-cyan-400">
            <span className="size-2 rounded-xs bg-cyan-400 shrink-0" />
            ROSBags Ingested:
          </span>
          <span className="font-semibold text-foreground">
            {dataPoint?.bags ?? 0}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-rose-400">
            <span className="size-2 rounded-xs bg-rose-400 shrink-0" />
            Anomalies:
          </span>
          <span className="font-semibold text-rose-400">
            {dataPoint?.anomalies ?? 0}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-purple-400">
            <span className="size-2 rounded-xs bg-purple-400 shrink-0" />
            P95 Latency:
          </span>
          <span className="font-semibold text-purple-300">
            {dataPoint?.p95Ms ? `${dataPoint.p95Ms} ms` : "--"}
          </span>
        </div>
      </div>
    </div>
  )
}

export function FleetTrendChart({ data }: FleetTrendChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
        No telemetry trend data available for the past 14 days.
      </div>
    )
  }

  const chartData = data.map((item) => ({
    ...item,
    formattedDate: formatDateLabel(item.date),
  }))

  return (
    <div className="w-full">
      <div className="h-64 w-full pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            margin={{ top: 12, right: 12, left: -20, bottom: 4 }}
          >
            <defs>
              <linearGradient id="bagsGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0284c7" stopOpacity={0.8} />
                <stop offset="100%" stopColor="#0284c7" stopOpacity={0.25} />
              </linearGradient>
              <linearGradient id="anomaliesGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.8} />
                <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.2} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="var(--border)"
              strokeOpacity={0.3}
            />

            <XAxis
              dataKey="formattedDate"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              dy={6}
            />

            <YAxis
              yAxisId="left"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              allowDecimals={false}
            />

            <YAxis
              yAxisId="right"
              orientation="right"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
              unit="ms"
              hide={true}
            />

            <Tooltip content={<CustomTooltip />} />

            <Bar
              yAxisId="left"
              dataKey="bags"
              name="ROSBags"
              fill="url(#bagsGradient)"
              radius={[3, 3, 0, 0]}
              maxBarSize={24}
            />

            <Bar
              yAxisId="left"
              dataKey="anomalies"
              name="Anomalies"
              fill="url(#anomaliesGradient)"
              radius={[3, 3, 0, 0]}
              maxBarSize={24}
            />

            <Line
              yAxisId="right"
              type="monotone"
              dataKey="p95Ms"
              name="P95 Latency"
              stroke="#94a3b8"
              strokeWidth={1.75}
              strokeDasharray="4 4"
              dot={{ r: 3, fill: "#94a3b8", strokeWidth: 1.5, stroke: "#0f172a" }}
              activeDot={{ r: 5, fill: "#e2e8f0" }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend footer */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-2 text-xs font-mono text-muted-foreground">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-xs bg-[#0284c7]" />
            <span>ROSBags</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-xs bg-[#f43f5e]" />
            <span>Anomalies</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 border-t border-dashed border-[#94a3b8] inline-block" />
            <span>P95 Latency (ms)</span>
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground/70">14-Day Statistical Window</span>
      </div>
    </div>
  )
}
