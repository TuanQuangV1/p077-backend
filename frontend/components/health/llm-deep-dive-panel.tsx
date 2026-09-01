"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { BotIcon, BrainCircuitIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon, HelpCircleIcon, LoaderIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { fetcher, post } from "@/lib/api"
import type { Anomaly, HealthSummary, LLMDeepDiveResult, Severity } from "@/lib/types"

/** `GET /api/v1/analysis/{id}/deep-dive` — health summary plus a ready prompt. */
interface DeepDiveContext {
  run_id: string
  triggered: boolean
  threshold: number
  health: HealthSummary
  prompt: string
}

/** `POST /api/v1/analysis/explain` — the LLM (or its canned fallback) response. */
interface ExplainResponse {
  root_cause: string
  recommended_actions: string[]
  explanation: string
}

const SEVERITY_TO_PRIORITY: Record<string, LLMDeepDiveResult["priority"]> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
}

/** Fold the backend's 3-field explanation into the panel's view model, filling
 *  priority / confidence / components from the health summary the same call
 *  returned — the explain endpoint itself does not score those. */
function deepDiveFromExplain(
  explain: ExplainResponse,
  health: HealthSummary,
  anomalies: Anomaly[],
): LLMDeepDiveResult {
  const worst = health.summary.worst_severity ?? "low"
  const priority = SEVERITY_TO_PRIORITY[worst] ?? "low"
  const confidence = worst === "critical" ? 0.9 : worst === "high" ? 0.8 : worst === "medium" ? 0.7 : 0.6
  const sentences = explain.explanation
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    summary: explain.root_cause,
    explanation: sentences.length > 0 ? sentences : [explain.explanation],
    suggestions: explain.recommended_actions,
    confidence,
    priority,
    affected_components: [...new Set(anomalies.flatMap((a) => a.topics))].slice(0, 6),
  }
}

/**
 * Client-side heuristic shown only when the deep-dive request fails (LLM
 * offline, network error). The panel badges this output as a fallback so it is
 * never mistaken for a real synthesis.
 */
function generateFallbackAnalysis(healthScore: number, anomalies: Anomaly[]): LLMDeepDiveResult {
  if (anomalies.length === 0) {
    return {
      summary: "Zero anomalies detected. Subsystems operating nominally.",
      explanation: [
        "All sensor telemetry streams within nominal QoS tolerances",
        "Topic publish cadence is stable and matches target Hz",
      ],
      suggestions: [
        "Continue passive monitoring in next mission lifecycle",
        "Maintain periodic sensor calibration routines",
      ],
      confidence: 0.95,
      priority: "low",
      affected_components: [],
    }
  }

  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const a of anomalies) {
    if (a.severity in severityCounts) severityCounts[a.severity as keyof typeof severityCounts]++
  }

  const explanations: string[] = []
  const suggestions: string[] = []
  const components: string[] = []

  if (severityCounts.critical > 0) {
    explanations.push(`${severityCounts.critical} critical fault(s) requiring immediate engineer intervention`)
    suggestions.push("Isolate affected kinematic/localization nodes and inspect core dump logs")
    suggestions.push("Review recent parameter changes in Nav2 controller / sensor drivers")
    components.push("system_critical")
  }
  if (severityCounts.high > 0) {
    explanations.push(`${severityCounts.high} high-severity anomaly(ies) impacting control loop fidelity`)
    suggestions.push("Schedule maintenance check on sensor bus and DDS QoS profile settings")
    suggestions.push("Monitor topic drop rates for potential cascade escalation")
    if (!components.includes("system_critical")) components.push("diagnostics")
  }

  const topicCounts = new Map<string, number>()
  for (const a of anomalies) {
    for (const topic of a.topics) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
  }
  const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (topTopics.length > 0) {
    explanations.push(`Primary affected topic streams: ${topTopics.map(([t]) => t).join(", ")}`)
  }

  const priority = severityCounts.critical > 0 ? "critical"
    : severityCounts.high > 0 ? "high"
    : severityCounts.medium > 0 ? "medium"
    : "low"
  const confidence = severityCounts.critical > 0 ? 0.9
    : severityCounts.high > 0 ? 0.8
    : severityCounts.medium > 0 ? 0.7
    : 0.6

  return {
    summary: `Fleet Health Index ${healthScore}/100: ${severityCounts.critical + severityCounts.high} critical/high issue(s), ${severityCounts.medium + severityCounts.low} medium/low observation(s)`,
    explanation: explanations,
    suggestions: [...new Set(suggestions)],
    confidence,
    priority: priority as LLMDeepDiveResult["priority"],
    affected_components: [...new Set(components)],
  }
}

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

const PRIORITY_LABELS: Record<string, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
}

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#6c757d",
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const el = document.createElement("textarea")
        el.value = text
        el.style.position = "fixed"
        el.style.opacity = "0"
        document.body.appendChild(el)
        el.select()
        document.execCommand("copy")
        document.body.removeChild(el)
      }
      setCopied(true)
      toast.success("Copied to clipboard")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={copy} className="cursor-pointer">
      {copied ? <CheckCircleIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </Button>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <LoaderIcon className="size-4 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">Synthesizing telemetry diagnostics...</span>
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
      <h3 className="text-lg font-semibold font-sans">System Operational</h3>
      <p className="mt-1 text-sm text-muted-foreground font-mono">
        Health Index {score}/100 — no critical faults detected.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Autonomous monitoring active for predictive maintenance.
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
  const [source, setSource] = useState<"llm" | "fallback" | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isAutoTriggered, setIsAutoTriggered] = useState(false)

  const score = health?.health_score ?? 0
  const triggerLLM = health?.trigger_llm_deep_dive ?? false

  const runDeepDive = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!activeRunId || !health) return
      setIsLoading(true)
      try {
        const [ctx, llm] = await Promise.all([
          fetcher<DeepDiveContext>(`/api/v1/analysis/${activeRunId}/deep-dive`),
          fetcher<{ ok: boolean }>("/api/v1/llm/health").catch(() => ({ ok: false })),
        ])
        // `explain_diagnostics` reads a flat `detections` list; the health
        // summary nests them under `detections_by_group`, so flatten a copy.
        const summary = {
          ...ctx.health,
          detections: Object.values(ctx.health.detections_by_group ?? {}).flat(),
        }
        const explain = await post<ExplainResponse>("/api/v1/analysis/explain", { summary })
        if (isCancelled()) return
        setDeepDive(deepDiveFromExplain(explain, ctx.health, anomalies))
        // The explain endpoint returns canned text (no marker) when the LLM is
        // not reachable, so its own health check is what tells us which it was.
        setSource(llm.ok ? "llm" : "fallback")
      } catch {
        if (isCancelled()) return
        setDeepDive(generateFallbackAnalysis(health.health_score, anomalies))
        setSource("fallback")
      } finally {
        if (!isCancelled()) setIsLoading(false)
      }
    },
    [activeRunId, health, anomalies],
  )

  // Which run has been auto-triggered. A ref rather than `isLoading` in the
  // dependency array: `runDeepDive` sets `isLoading` synchronously, so that
  // dependency re-ran this effect immediately and its cleanup cancelled the
  // request it had just started. The cancelled call then skipped both
  // `setDeepDive` and its own `setIsLoading(false)`, leaving the panel spinning
  // on "Synthesizing telemetry diagnostics..." forever while the guard above
  // refused to retry. Cancel only when the run actually changes.
  const autoTriggeredRunRef = useRef<string | null>(null)
  useEffect(() => {
    if (!triggerLLM || !activeRunId || deepDive) return
    if (autoTriggeredRunRef.current === activeRunId) return
    autoTriggeredRunRef.current = activeRunId
    setIsAutoTriggered(true)
    void runDeepDive(() => autoTriggeredRunRef.current !== activeRunId)
  }, [triggerLLM, activeRunId, deepDive, runDeepDive])

  const triggerDeepDive = () => {
    void runDeepDive()
  }

  const exportJSON = () => {
    const data = {
      health,
      deepDive,
      anomalies,
      exportedAt: new Date().toISOString(),
    }
    const runLabel = activeRunId ?? new Date().toISOString()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `health-analysis-${runLabel}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 0)
    toast.success("Exported diagnostic report JSON")
  }

  if (!health) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BrainCircuitIcon className="size-4" />
            LLM Deep-Dive RCA Engine
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
            LLM Deep-Dive RCA Engine
            <Badge variant="outline" className="ml-auto text-[10px]">
              Autonomous
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
    <Card>
      <CardHeader className="pb-3 border-b border-border/70">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <BrainCircuitIcon className="size-4 text-primary" />
            <span>LLM Deep-Dive RCA Engine</span>
            {isAutoTriggered && triggerLLM && (
              <Badge variant="outline" className="text-[10px] font-mono border-amber-500/40 text-amber-500 bg-amber-500/5">
                Auto-triggered
              </Badge>
            )}
            {source === "fallback" && (
              <Tooltip>
                <TooltipTrigger className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/5 px-1.5 py-0.5 text-[10px] font-mono text-amber-500 cursor-help">
                  Fallback · LLM offline
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs text-xs">
                  The language model is not reachable, so this is a deterministic
                  rule-based summary, not a real synthesis.
                </TooltipContent>
              </Tooltip>
            )}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger className="size-7 inline-flex items-center justify-center rounded-md hover:bg-accent cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
                <HelpCircleIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs text-xs">
                LLM agent correlates multiple ROS2 anomaly streams to synthesize root causes and actionable remediations.
              </TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              className="size-7 p-0 cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={exportJSON}
              title="Export report JSON"
            >
              <DownloadIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-7 p-0 cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={triggerDeepDive}
              disabled={isLoading}
              title="Re-run synthesis"
            >
              <RefreshCwIcon className={`size-3.5 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4">
        {isLoading && !deepDive ? (
          <LoadingSkeleton />
        ) : deepDive ? (
          <div className="grid gap-5 lg:grid-cols-2 items-start font-sans">
            {/* LEFT COLUMN: The Why (Executive Summary, RCA, Impacted Subsystems) */}
            <div className="space-y-4">
              {/* Executive Diagnostic Summary */}
              <div
                className="rounded-xl border p-3.5 shadow-xs transition-colors"
                style={{
                  borderColor: `${priorityColor}35`,
                  backgroundColor: `${priorityColor}06`,
                }}
              >
                <div className="flex items-center justify-between border-b border-border/50 pb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                    Executive Diagnostic Summary
                  </h4>
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span style={{ color: priorityColor }} className="font-semibold">
                      Confidence {Math.round(deepDive.confidence * 100)}%
                    </span>
                    <span className="text-muted-foreground">|</span>
                    <Badge
                      variant="outline"
                      className="text-[10px] font-bold uppercase tracking-wider"
                      style={{
                        borderColor: priorityColor,
                        color: priorityColor,
                        backgroundColor: `${priorityColor}15`,
                      }}
                    >
                      {PRIORITY_LABELS[deepDive.priority] ?? deepDive.priority.toUpperCase()}
                    </Badge>
                  </div>
                </div>
                <p className="mt-2.5 text-xs text-foreground leading-relaxed">
                  {deepDive.summary}
                </p>
              </div>

              {/* Root Cause Analysis (RCA) */}
              {deepDive.explanation.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                    Root Cause Analysis (RCA)
                  </h4>
                  <ul className="space-y-2">
                    {deepDive.explanation.map((exp, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-card/60 p-2.5 text-xs text-foreground leading-relaxed shadow-2xs"
                      >
                        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded bg-primary/10 text-primary font-mono text-[10px] font-bold">
                          {i + 1}
                        </span>
                        <span className="flex-1">{exp}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Impacted Subsystems */}
              {deepDive.affected_components.length > 0 && (
                <div className="flex items-center gap-2 pt-1 font-mono text-xs">
                  <span className="text-[10.5px] font-semibold uppercase text-muted-foreground">
                    Impacted Subsystems:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {deepDive.affected_components.map((comp) => (
                      <Badge
                        key={comp}
                        variant="secondary"
                        className="font-mono text-[10px] uppercase font-semibold"
                      >
                        {comp}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT COLUMN: The How & When (Remediation Actions & Correlated Anomalies) */}
            <div className="space-y-4">
              {/* Recommended Remediation Actions */}
              {deepDive.suggestions.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                    Recommended Remediation Actions
                  </h4>
                  <div className="space-y-2">
                    {deepDive.suggestions.map((suggestion, i) => (
                      <Collapsible key={i}>
                        <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:bg-accent hover:border-primary/40 cursor-pointer shadow-2xs">
                          <CheckCircleIcon className="size-4 shrink-0 text-green-500" />
                          <span className="flex-1 text-xs font-medium text-foreground">{suggestion}</span>
                          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform ui-open:rotate-180" />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="px-3.5 py-2 border-x border-b border-border/60 rounded-b-lg -mt-1 bg-muted/20 text-xs text-muted-foreground">
                          Inspect corresponding ROS2 launch parameters, DDS XML configuration, and Nav2 controller settings.
                        </CollapsibleContent>
                      </Collapsible>
                    ))}
                  </div>
                </div>
              )}

              {/* Correlated Anomalies with 1-Click Timeline Seek */}
              {anomalies.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <h4 className="font-semibold uppercase tracking-wider text-muted-foreground">
                      Correlated Faults ({anomalies.length})
                    </h4>
                    <span className="text-[10px] text-muted-foreground">Click to seek timeline</span>
                  </div>
                  <div className="divide-y divide-border/60 rounded-lg border border-border bg-card/80 overflow-hidden shadow-2xs">
                    {anomalies.slice(0, 5).map((anomaly) => (
                      <button
                        key={anomaly.id}
                        onClick={() => onSelectAnomaly?.(anomaly.id)}
                        className="group flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-accent/60 transition-colors cursor-pointer"
                        title="Click to seek timeline to this anomaly"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: SEVERITY_COLORS[anomaly.severity] }}
                          />
                          <span className="font-medium truncate group-hover:text-primary transition-colors">
                            {anomaly.title}
                          </span>
                          {anomaly.topics?.length > 0 && (
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {anomaly.topics[0]}
                            </span>
                          )}
                        </div>
                        <span className="font-mono text-[10.5px] text-muted-foreground group-hover:text-primary shrink-0 ml-2">
                          t={(anomaly.tRelSec ?? anomaly.tSec ?? 0).toFixed(1)}s &rarr;
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center">
            <BotIcon className="size-12 text-muted-foreground mb-3" />
            <p className="text-xs text-muted-foreground font-sans">
              Click below to synthesize root causes using specialized diagnostics engine.
            </p>
            <Button
              className="mt-3 cursor-pointer"
              size="sm"
              onClick={triggerDeepDive}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <LoaderIcon className="mr-2 size-3.5 animate-spin" />
                  Synthesizing...
                </>
              ) : (
                <>
                  <BrainCircuitIcon className="mr-2 size-3.5" />
                  Run LLM Diagnostics
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
