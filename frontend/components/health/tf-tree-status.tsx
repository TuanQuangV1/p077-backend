"use client"

import { useState } from "react"
import { GitBranchIcon, AlertCircleIcon, CheckCircleIcon, HelpCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Anomaly, Severity } from "@/lib/types"
import { relativeSpan } from "@/lib/anomaly-groups"

interface TFTreeStatusProps {
  tfAnomalies: Anomaly[]
  onSelectAnomaly?: (id: string) => void
}

interface TFNode {
  id: string
  label: string
  parent: string | null
  status: "healthy" | "gap" | "jump"
  anomalyId?: string
  details?: string
}

const FRAME_COLORS = {
  healthy: "#28a745",
  gap: "#dc3545",
  jump: "#dc3545",
}

const NODE_ICONS = {
  healthy: CheckCircleIcon,
  gap: AlertCircleIcon,
  jump: AlertCircleIcon,
}

function TFNodeComponent({
  node,
  isRoot,
  anomaly,
  onSelect,
}: {
  node: TFNode
  isRoot: boolean
  anomaly?: Anomaly
  onSelect?: (id: string) => void
}) {
  const Icon = NODE_ICONS[node.status]
  const color = FRAME_COLORS[node.status]

  return (
    <div className="flex flex-col items-center">
      {/* Node */}
      <button
        onClick={() => node.anomalyId && onSelect?.(node.anomalyId)}
        className={`
          flex flex-col items-center gap-1 rounded-lg border-2 p-3
          transition-colors
          ${node.anomalyId ? "cursor-pointer hover:bg-accent" : "cursor-default"}
        `}
        style={{
          borderColor: color,
          backgroundColor: `${color}10`,
        }}
      >
        <Icon className="size-5" style={{ color }} />
        <span className="text-xs font-semibold">{node.label}</span>
        {isRoot && (
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            GỐC
          </span>
        )}
      </button>

      {/* Anomaly Details */}
      {node.anomalyId && anomaly && (
        <div className="mt-2 max-w-[180px] rounded border border-border bg-card p-2">
          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className="text-[9px] uppercase"
              style={{
                borderColor: FRAME_COLORS[node.status],
                color: FRAME_COLORS[node.status],
              }}
            >
              {node.status === "gap" ? "Đứt đoạn" : "Nhảy tọa độ"}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              t={relativeSpan(anomaly).start.toFixed(1)}s
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground line-clamp-2">
            {node.details}
          </p>
        </div>
      )}
    </div>
  )
}

function TFEdge({
  fromLabel,
  toLabel,
  status,
  label,
}: {
  fromLabel: string
  toLabel: string
  status: "healthy" | "gap" | "jump"
  label?: string
}) {
  const isHealthy = status === "healthy"
  const color = FRAME_COLORS[status]

  return (
    <div className="flex items-center">
      {/* Arrow line */}
      <div className="relative flex items-center">
        <div
          className="h-0.5 w-16"
          style={{
            backgroundColor: color,
          }}
        />
        {/* Arrow head */}
        <div
          className="size-0 border-y-4 border-l-6 border-y-transparent"
          style={{
            borderLeftColor: color,
          }}
        />

        {/* Edge label / Status badge */}
        {label && (
          <div
            className="absolute -top-5 left-1/2 -translate-x-1/2 rounded px-1 text-[9px] font-bold"
            style={{
              backgroundColor: `${color}20`,
              color,
              border: `1px solid ${color}`,
            }}
          >
            {label}
          </div>
        )}
      </div>
    </div>
  )
}

export function TFTreeStatus({
  tfAnomalies,
  onSelectAnomaly,
}: TFTreeStatusProps) {
  const [showHelp, setShowHelp] = useState(false)

  // Determine tree node statuses based on anomalies
  const hasGap = tfAnomalies.some((a) => a.kind === "tf_missing_gap" || a.kind === "tf_timeout" || a.kind === "frequency_gap")
  const hasJump = tfAnomalies.some((a) => a.kind === "tf_drift_jump" || a.kind === "tf_conflict" || a.kind === "localization_jump")

  // Mock tree structure: map -> odom -> base_link
  const nodes: TFNode[] = [
    {
      id: "map",
      label: "map",
      parent: null,
      status: "healthy",
    },
    {
      id: "odom",
      label: "odom",
      parent: "map",
      status: hasJump ? "jump" : hasGap ? "gap" : "healthy",
      anomalyId: hasJump || hasGap ? tfAnomalies[0]?.id : undefined,
      details: hasJump
        ? "Khung bị nhảy tọa độ"
        : hasGap
        ? "Phát hiện đứt đoạn tọa độ"
        : undefined,
    },
    {
      id: "base_link",
      label: "base_link",
      parent: "odom",
      status: "healthy",
    },
  ]

  const hasAnyAnomaly = hasGap || hasJump

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitBranchIcon className="size-4" />
            Trạng thái cây tọa độ TF
          </CardTitle>
          <Tooltip>
            <TooltipTrigger
              onClick={() => setShowHelp(!showHelp)}
              className="rounded p-1 hover:bg-accent"
            >
              <HelpCircleIcon className="size-4 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs text-xs">
              <p className="font-semibold">Trực quan hóa Cây TF</p>
              <p className="mt-1 text-muted-foreground">
                Hiển thị chuỗi chuyển đổi tọa độ. Xanh = bình thường, Đỏ =
                phát hiện bất thường.
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        {/* Help panel */}
        {showHelp && (
          <div className="mb-3 rounded border border-border bg-muted/50 p-2 text-[10px]">
            <p className="font-semibold">Chuỗi chuyển đổi:</p>
            <p className="mt-0.5 text-muted-foreground">
              map &rarr; odom &rarr; base_link
            </p>
            <p className="mt-1 font-semibold">Màu sắc trạng thái:</p>
            <div className="mt-0.5 space-y-0.5 text-muted-foreground">
              <p>
                <span className="inline-block size-2 rounded-full bg-green-500" />{" "}
                Xanh = Chuyển đổi bình thường
              </p>
              <p>
                <span className="inline-block size-2 rounded-full bg-red-500" />{" "}
                Đỏ = Phát hiện bị đứt đoạn hoặc nhảy giá trị
              </p>
            </div>
          </div>
        )}

        {/* TF Tree visualization */}
        <div className="flex items-start justify-center gap-8 py-4">
          <TFNodeComponent
            node={nodes[0]}
            isRoot={true}
            onSelect={onSelectAnomaly}
          />
          <TFEdge
            fromLabel={nodes[0].label}
            toLabel={nodes[1].label}
            status={nodes[1].status}
            label={hasAnyAnomaly ? "GAP" : undefined}
          />
          <TFNodeComponent
            node={nodes[1]}
            isRoot={false}
            anomaly={tfAnomalies[0]}
            onSelect={onSelectAnomaly}
          />
          <TFEdge
            fromLabel={nodes[1].label}
            toLabel={nodes[2].label}
            status="healthy"
          />
          <TFNodeComponent
            node={nodes[2]}
            isRoot={false}
            onSelect={onSelectAnomaly}
          />
        </div>

        {/* Anomaly Summary */}
        {tfAnomalies.length > 0 && (
          <div className="space-y-1.5 border-t border-border pt-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sự cố phát hiện ({tfAnomalies.length})
            </span>
            {tfAnomalies.map((anomaly) => (
              <button
                key={anomaly.id}
                onClick={() => onSelectAnomaly?.(anomaly.id)}
                className="flex w-full items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <AlertCircleIcon
                  className="size-3"
                  style={{ color: FRAME_COLORS[anomaly.severity === "critical" ? "jump" : "gap"] }}
                />
                <span className="flex-1 truncate text-xs">
                  {anomaly.title}
                </span>
                <Badge
                  variant="outline"
                  className="text-[9px] uppercase"
                  style={{
                    borderColor:
                      anomaly.severity === "critical"
                        ? "#dc3545"
                        : "#fd7e14",
                    color:
                      anomaly.severity === "critical"
                        ? "#dc3545"
                        : "#fd7e14",
                  }}
                >
                  {anomaly.severity === "critical" ? "Nghiêm trọng" : "Cảnh báo"}
                </Badge>
              </button>
            ))}
          </div>
        )}

        {/* No anomalies */}
        {!hasAnyAnomaly && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
            <CheckCircleIcon className="size-4 text-green-500" />
            <span className="font-medium text-emerald-400">Tất cả liên kết tọa độ hoạt động bình thường</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
