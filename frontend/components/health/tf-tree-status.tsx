"use client"

import { useState } from "react"
import { GitBranchIcon, AlertCircleIcon, CheckCircleIcon, HelpCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Anomaly } from "@/lib/types"
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

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
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
        title={node.anomalyId ? "🎯 Click to sync and focus timeline" : undefined}
        className={`
          flex min-w-[76px] sm:min-w-[90px] flex-col items-center gap-1 rounded-xl border-2 px-3 py-2.5
          transition-all shadow-xs
          ${node.anomalyId ? "cursor-pointer hover:bg-accent hover:scale-105 hover:border-primary" : "cursor-default"}
        `}
        style={{
          borderColor: color,
          backgroundColor: `${color}10`,
        }}
      >
        <Icon className="size-4 sm:size-5" style={{ color }} />
        <span className="text-xs font-bold font-mono tracking-tight">{node.label}</span>
        {isRoot && (
          <span className="text-[8.5px] uppercase tracking-wider text-muted-foreground font-mono font-semibold">
            root frame
          </span>
        )}
      </button>

      {/* Anomaly Details */}
      {node.anomalyId && anomaly && (
        <div className="mt-2 max-w-[180px] rounded-lg border border-border bg-card p-2 shadow-sm text-left">
          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className="text-[9px] font-mono"
              style={{
                borderColor: color,
                color,
              }}
            >
              {anomaly.kind}
            </Badge>
            <span
              className="text-[9px] font-bold uppercase font-mono"
              style={{ color }}
            >
              {SEVERITY_LABEL[anomaly.severity] ?? anomaly.severity}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground font-sans">
            {node.details}
          </p>
          <p className="mt-0.5 font-mono text-[9px] text-muted-foreground">
            t={relativeSpan(anomaly).start.toFixed(1)}s
          </p>
        </div>
      )}
    </div>
  )
}

function TFEdge({
  status,
  label,
}: {
  fromLabel: string
  toLabel: string
  status: "healthy" | "gap" | "jump"
  label?: string
}) {
  const color = FRAME_COLORS[status]
  const isHealthy = status === "healthy"

  return (
    <div className="flex flex-col items-center justify-center self-center px-1">
      {label && (
        <span
          className="mb-1 rounded px-1.5 py-0.5 text-[8.5px] font-mono font-bold uppercase tracking-wider"
          style={{
            backgroundColor: `${color}20`,
            color,
            border: `1px solid ${color}40`,
          }}
        >
          {label}
        </span>
      )}
      <div className="flex items-center">
        {/* Horizontal Connector Line */}
        <div
          className="h-0.5 w-6 sm:w-10 rounded-full transition-all"
          style={{
            backgroundColor: color,
            opacity: isHealthy ? 0.65 : 1,
          }}
        />
        {/* Directional Arrow Head pointing right */}
        <svg
          width="8"
          height="12"
          viewBox="0 0 8 12"
          className="-ml-1 shrink-0"
          style={{ color }}
        >
          <path
            d="M 1 1 L 7 6 L 1 11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}

export function TFTreeStatus({
  tfAnomalies,
  onSelectAnomaly,
}: TFTreeStatusProps) {
  const [showHelp, setShowHelp] = useState(false)

  // Determine TF chain status
  const hasGap = tfAnomalies.some((a) => a.kind === "tf_missing_gap" || a.kind === "tf_timeout")
  const hasJump = tfAnomalies.some(
    (a) =>
      a.kind === "tf_drift_jump" ||
      a.kind === "tf_conflict" ||
      a.kind === "localization_jump",
  )

  // Build TF nodes
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
        ? "Transform discontinuity / frame re-latch detected"
        : hasGap
        ? "Transform buffer gap / timeout"
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
            TF2 Transform Tree & Coordinate Hierarchy
          </CardTitle>
          <Tooltip>
            <TooltipTrigger
              onClick={() => setShowHelp(!showHelp)}
              className="rounded p-1 hover:bg-accent cursor-pointer"
            >
              <HelpCircleIcon className="size-4 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs text-xs">
              <p className="font-semibold">TF2 Coordinate Hierarchy</p>
              <p className="mt-1 text-muted-foreground">
                Displays kinematic transform chain integrity. Green = nominal transform buffer, Red = transform gap or extrapolation jump.
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        {/* Help panel */}
        {showHelp && (
          <div className="mb-3 rounded border border-border bg-muted/50 p-2 text-[10px]">
            <p className="font-semibold font-mono">Transform Chain:</p>
            <p className="mt-0.5 text-muted-foreground font-mono">
              map &rarr; odom &rarr; base_link
            </p>
            <p className="mt-1 font-semibold">Status Coding:</p>
            <div className="mt-0.5 space-y-0.5 text-muted-foreground">
              <p>
                <span className="inline-block size-2 rounded-full bg-green-500" />{" "}
                Green = Transform buffer continuous
              </p>
              <p>
                <span className="inline-block size-2 rounded-full bg-red-500" />{" "}
                Red = Transform gap or pose extrapolation jump
              </p>
            </div>
          </div>
        )}

        {/* TF Tree visualization */}
        <div className="flex items-center justify-center gap-2 sm:gap-5 py-4">
          <TFNodeComponent
            node={nodes[0]}
            isRoot={true}
            onSelect={onSelectAnomaly}
          />
          <TFEdge
            fromLabel={nodes[0].label}
            toLabel={nodes[1].label}
            status={nodes[1].status}
            label={hasAnyAnomaly ? "TF GAP" : undefined}
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
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground font-mono">
              TF Transform Faults
            </span>
            {tfAnomalies.map((anomaly) => (
              <button
                key={anomaly.id}
                onClick={() => onSelectAnomaly?.(anomaly.id)}
                className="flex w-full items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left transition-colors hover:bg-accent cursor-pointer"
              >
                <AlertCircleIcon
                  className="size-3"
                  style={{ color: FRAME_COLORS[anomaly.severity === "critical" ? "jump" : "gap"] }}
                />
                <span className="flex-1 truncate text-xs font-medium">
                  {anomaly.title}
                </span>
                <Badge
                  variant="outline"
                  className="text-[9px] font-mono"
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
                  {SEVERITY_LABEL[anomaly.severity] ?? anomaly.severity}
                </Badge>
              </button>
            ))}
          </div>
        )}

        {/* No anomalies */}
        {!hasAnyAnomaly && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground font-mono">
            <CheckCircleIcon className="size-4 text-green-500" />
            <span>All coordinate transforms nominal</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
