"use client"

import { useEffect, useState } from "react"
import { BotIcon, BrainCircuitIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon, HelpCircleIcon, LoaderIcon, RefreshCwIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { fetcher, post } from "@/lib/api"
import type { Anomaly, HealthSummary, LLMDeepDiveResult, Severity } from "@/lib/types"

interface LLMDeepDivePanelProps {
  health: HealthSummary | null
  activeRunId: string | null
  anomalies: Anomaly[]
  onSelectAnomaly?: (id: string) => void
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#6c757d",
}

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#6c757d",
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      toast.success("Copied to clipboard")
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <Button variant="ghost" size="sm" onClick={copy}>
      {copied ? <CheckCircleIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </Button>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <LoaderIcon className="size-4 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">Analyzing health data...</span>
      </div>
      <div className="space-y-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}

function EmptyState({ score }: { score: number }) {
  return (
    <div className="flex flex-col items-center justify-center p-6 text-center">
      <CheckCircleIcon className="size-12 text-green-500 mb-3" />
      <h3 className="text-lg font-semibold">System Healthy</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Health Score {score}/100 - no critical issues detected.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Continue monitoring for proactive maintenance.
      </p>
    </div>
  )
}

export function LLMDeepDivePanel({
  health,
  activeRunId,
  anomalies,
  onSelectAnomaly,
}: LLMDeepDivePanelProps) {
  const [deepDive, setDeepDive] = useState<LLMDeepDiveResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isAutoTriggered, setIsAutoTriggered] = useState(false)

  const score = health?.health_score ?? 0
  const status = health?.status ?? "green"
  const triggerLLM = health?.trigger_llm_deep_dive ?? false

  // Auto-trigger deep-dive when health score drops below threshold
  useEffect(() => {
    if (triggerLLM && activeRunId && !deepDive && !isLoading) {
      setIsAutoTriggered(true)
      triggerDeepDive()
    }
  }, [triggerLLM, activeRunId])

  const triggerDeepDive = async () => {
    if (!activeRunId || isLoading) return

    setIsLoading(true)
    try {
      const result = await fetcher<LLMDeepDiveResult>(
        `/api/runs/${activeRunId}/deep-dive`
      )
      setDeepDive(result)
    } catch (err) {
      console.error("Deep-dive error:", err)
      toast.error("Failed to get LLM analysis")
    } finally {
      setIsLoading(false)
    }
  }

  const exportJSON = () => {
    const data = {
      health,
      deepDive,
      anomalies,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `health-analysis-${activeRunId}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success("Exported health analysis")
  }

  if (!health) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BrainCircuitIcon className="size-4" />
            LLM Deep-Dive Analysis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LoadingSkeleton />
        </CardContent>
      </Card>
    )
  }

  if (score >= 80 && !deepDive) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BrainCircuitIcon className="size-4" />
            LLM Deep-Dive Analysis
            <Badge variant="outline" className="ml-auto text-[10px]">
              Auto
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState score={score} />
        </CardContent>
      </Card>
    )
  }

  const priorityColor = deepDive ? PRIORITY_COLORS[deepDive.priority] : "#6c757d"

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BrainCircuitIcon className="size-4" />
            LLM Deep-Dive Analysis
            {isAutoTriggered && triggerLLM && (
              <Badge variant="outline" className="text-[10px]">
                Auto-triggered (HS &lt; 70)
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger>
                <Button variant="ghost" size="sm" className="size-8 p-0">
                  <HelpCircleIcon className="size-4 text-muted-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs text-xs">
                LLM analyzes health data to identify root causes and suggest fixes.
                Auto-triggers when Health Score drops below 70.
              </TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0"
              onClick={exportJSON}
            >
              <DownloadIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0"
              onClick={triggerDeepDive}
              disabled={isLoading}
            >
              <RefreshCwIcon className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading && !deepDive ? (
          <LoadingSkeleton />
        ) : deepDive ? (
          <>
            {/* Executive Summary */}
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: `${priorityColor}30`,
                backgroundColor: `${priorityColor}05`,
              }}
            >
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Executive Summary
                </h4>
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs font-medium"
                    style={{ color: priorityColor }}
                  >
                    {Math.round(deepDive.confidence * 100)}% confidence
                  </span>
                  <span className="text-muted-foreground">|</span>
                  <Badge
                    variant="outline"
                    className="text-[10px]"
                    style={{
                      borderColor: priorityColor,
                      color: priorityColor,
                    }}
                  >
                    {deepDive.priority.toUpperCase()}
                  </Badge>
                </div>
              </div>
              <p className="mt-2 text-sm">{deepDive.summary}</p>
            </div>

            {/* Root Cause Analysis */}
            {deepDive.explanation.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Root Cause Analysis
                </h4>
                <ul className="mt-2 space-y-1.5">
                  {deepDive.explanation.map((exp, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                      <span>{exp}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Affected Components */}
            {deepDive.affected_components.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Affected Components
                </h4>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {deepDive.affected_components.map((comp) => (
                    <Badge
                      key={comp}
                      variant="secondary"
                      className="font-mono text-[10px]"
                    >
                      {comp}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Recommended Fixes */}
            {deepDive.suggestions.length > 0 && (
              <div>
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Recommended Fixes
                  </h4>
                </div>
                <div className="mt-2 space-y-2">
                  {deepDive.suggestions.map((suggestion, i) => (
                    <Collapsible key={i}>
                      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:bg-accent">
                        <CheckCircleIcon className="size-4 shrink-0 text-green-500" />
                        <span className="flex-1 text-sm">{suggestion}</span>
                        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform ui-open:rotate-180" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                          Check the relevant configuration files and ROS2 parameters.
                          Refer to Nav2 documentation for best practices.
                        </p>
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              </div>
            )}

            {/* Related Detections */}
            {anomalies.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Related Detections
                </h4>
                <div className="mt-2 space-y-1">
                  {anomalies.slice(0, 5).map((anomaly) => (
                    <button
                      key={anomaly.id}
                      onClick={() => onSelectAnomaly?.(anomaly.id)}
                      className="flex w-full items-center gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: SEVERITY_COLORS[anomaly.severity] }}
                      />
                      <span className="flex-1 truncate text-xs">{anomaly.title}</span>
                      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center">
            <BotIcon className="size-12 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              Click to analyze health data with LLM
            </p>
            <Button
              className="mt-3"
              size="sm"
              onClick={triggerDeepDive}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <LoaderIcon className="mr-2 size-4 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <BrainCircuitIcon className="mr-2 size-4" />
                  Ask LLM
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
