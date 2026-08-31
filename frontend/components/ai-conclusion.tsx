"use client"

import { useState } from "react"
import { CheckIcon, PencilIcon, SparklesIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { SeverityBadge } from "@/components/telemetry"
import { clock, ms, post } from "@/lib/api"
import type { AIResult, Anomaly } from "@/lib/types"
import { cn } from "@/lib/utils"

const REVIEWER_KEY = "rav13.reviewer"

/** Reviewer identity for the audit trail. No auth system yet, so it is stored
 *  locally and prompted for once, rather than logging every verdict as "reviewer". */
export function getReviewer(): string {
    if (typeof window === "undefined") return "reviewer"
    return window.localStorage.getItem(REVIEWER_KEY) || "reviewer"
}

export function setReviewer(name: string): void {
    if (typeof window !== "undefined") window.localStorage.setItem(REVIEWER_KEY, name)
}

/** "2026-08-12T05:04:23Z" -> "Aug 12 12:04" for the reviewed-at badge. */
function reviewedStamp(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return d.toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
}

const REVIEW_STATUS_LABEL: Record<string, string> = {
    pending: "Pending Review",
    approved: "Approved",
    rejected: "Rejected",
    edited: "Modified",
}

const VERDICT_TOAST_LABEL: Record<string, string> = {
    approved: "Verdict recorded: Approved",
    rejected: "Verdict recorded: Rejected",
    edited: "Verdict recorded: Modified",
}

/**
 * One agent conclusion with its evidence chain and the human verdict controls.
 * Shared by the analysis workspace and the review queue so a reviewer sees
 * exactly the same card in both places.
 */
export function AIConclusion({
  result,
  anomaly,
  onSeek,
  onReviewed,
  compact = false,
}: {
  result: AIResult
  anomaly?: Anomaly
  onSeek?: (t: number) => void
  onReviewed?: (result: AIResult) => void
  compact?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(result.rootCause)
  const [notes, setNotes] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (verdict: "approved" | "rejected" | "edited") => {
    setBusy(true)
    try {
      // Review items and AI results share the same 1-based index minted together
      // in analysis.py, so "ai_003" maps to "review_{runId}_003".
      const suffix = result.id.replace(/^ai_/, "")
      const reviewId = `review_${result.runId}_${suffix}`
      const combinedNotes = verdict === "edited"
        ? `Modified root cause: ${draft}${notes ? ` — ${notes}` : ""}`
        : notes || undefined
      const reviewer = getReviewer()
      const saved = await post<{ reviewer: string }>(`/api/review/${reviewId}/decision`, {
        verdict,
        reviewer,
        notes: combinedNotes,
      })
      toast.success(VERDICT_TOAST_LABEL[verdict] ?? verdict, { description: result.issue })
      setEditing(false)
      onReviewed?.({
        ...result,
        reviewStatus: verdict,
        rootCause: verdict === "edited" ? draft : result.rootCause,
        reviewer: saved.reviewer ?? reviewer,
        reviewerNote: combinedNotes ?? null,
        reviewedAt: new Date().toISOString(),
      })
    } catch {
      toast.error("Failed to record review verdict")
    } finally {
      setBusy(false)
    }
  }

  const reviewed = result.reviewStatus !== "pending"

  const modelLabel =
    result.model === "canned-fallback"
      ? "Heuristic Rule Engine"
      : result.model.split("/").pop() ?? result.model

  return (
    <Card className={cn("gap-3 py-3.5 shadow-xs border-border/70 bg-card/60", compact && "border-border/60")}>
      <CardHeader className="gap-2 px-4 pb-2 border-b border-border/40">
        <div className="flex flex-wrap items-center gap-2">
          {anomaly ? <SeverityBadge severity={anomaly.severity} /> : null}
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground bg-muted/20 border-border/60">
            {modelLabel}
          </Badge>
          {reviewed ? (
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[10px] uppercase font-semibold",
                result.reviewStatus === "approved" && "border-emerald-500/30 bg-emerald-500/8 text-emerald-400/90",
                result.reviewStatus === "rejected" && "border-rose-500/30 bg-rose-500/8 text-rose-400/90",
                result.reviewStatus === "edited" && "border-border/60 bg-muted/20 text-foreground/80",
              )}
            >
              {REVIEW_STATUS_LABEL[result.reviewStatus] ?? result.reviewStatus}
              {result.reviewedAt ? ` · ${reviewedStamp(result.reviewedAt)}` : ""}
              {result.reviewer ? ` · ${result.reviewer}` : ""}
            </Badge>
          ) : (
            <Badge variant="outline" className="font-mono text-[10px] uppercase font-semibold text-muted-foreground border-border/60 bg-muted/20">
              Pending Review
            </Badge>
          )}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
            {ms(result.latencyMs)} · {result.promptTokens + result.completionTokens} tok
          </span>
        </div>
        <CardTitle className="text-sm font-semibold leading-snug text-pretty pt-1">{result.issue}</CardTitle>
      </CardHeader>

      <CardContent className={cn("px-4 pt-2", compact ? "flex flex-col gap-3" : "grid grid-cols-1 lg:grid-cols-2 gap-4")}>
        {/* Left column: Confidence + RCA */}
        <div className="flex flex-col gap-3">
          {/* Confidence Progress Bar */}
          <div className="flex flex-col gap-1.5 rounded-md border border-border/50 bg-muted/10 p-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                Diagnostic Confidence
              </span>
              <span className="font-mono text-xs tabular-nums font-bold text-foreground">
                {(result.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
              <div
                className="h-full rounded-full bg-primary/50 transition-all duration-500"
                style={{ width: `${Math.max(8, result.confidence * 100)}%` }}
              />
            </div>
          </div>

          {/* Root Cause Analysis */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground font-mono">
              Root Cause Analysis (RCA)
            </span>
            {editing ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`rc-${result.id}`} className="sr-only">
                    Modified Root Cause
                  </FieldLabel>
                  <Textarea
                    id={`rc-${result.id}`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    className="text-xs font-mono"
                  />
                  <FieldDescription className="text-[11px]">
                    Corrections are persisted as labeled ground-truth training artifacts for subsequent model fine-tuning.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`nt-${result.id}`} className="text-xs font-mono">
                    Reviewer Notes
                  </FieldLabel>
                  <Textarea
                    id={`nt-${result.id}`}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    placeholder="What context or telemetry signal did the AI model miss?"
                    className="text-xs font-mono"
                  />
                </Field>
              </FieldGroup>
            ) : (
              <div className="rounded-lg border border-border/70 bg-card/60 p-2.5 text-xs text-foreground leading-relaxed">
                {result.rootCause !== result.issue && (
                  <p className="font-medium text-foreground pb-1">{result.rootCause}</p>
                )}
                {result.explanation ? (
                  <p className="text-muted-foreground leading-relaxed">{result.explanation}</p>
                ) : null}
              </div>
            )}
          </div>

          {reviewed && result.reviewerNote ? (
            <div className="flex flex-col gap-1 border-l-2 border-border/60 pl-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Reviewer Audit Note
              </span>
              <p className="text-xs leading-relaxed text-foreground/85">{result.reviewerNote}</p>
            </div>
          ) : null}
        </div>

        {/* Right column: Evidence Chain + Remediation */}
        <div className="flex flex-col gap-3">
          {/* Evidence Chain */}
          {result.evidence?.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                Evidence Chain (Telemetry Timestamps)
              </span>
              <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/80 overflow-hidden font-mono text-[11px]">
                {result.evidence.map((e, i) => (
                  <button
                    key={`${e.topic}-${i}`}
                    type="button"
                    onClick={() => onSeek?.(e.tSec)}
                    disabled={!onSeek}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors",
                      onSeek ? "hover:bg-accent/60 cursor-pointer" : "cursor-default",
                    )}
                    title={onSeek ? "Click to jump to this evidence timestamp on timeline" : undefined}
                  >
                    <span className="w-[58px] shrink-0 tabular-nums text-foreground font-semibold">
                      {clock(e.tSec)}
                    </span>
                    <span className="shrink-0 rounded bg-muted/40 px-1 py-0.5 text-[10px] text-muted-foreground font-medium">
                      {e.topic}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground font-sans text-xs">
                      {e.detail}
                    </span>
                    <span className="text-[10px] text-muted-foreground/50 shrink-0">&rarr;</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Recommended Remediation */}
          {result.suggestedFix?.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                Recommended Remediation
              </span>
              <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-xs leading-relaxed text-foreground">
                {result.suggestedFix.map((f, i) => (
                  <li key={i} className="text-foreground/90 font-sans">
                    {f}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2 px-4 pt-2 border-t border-border/40">
        {editing ? (
          <>
            <Button size="sm" onClick={() => submit("edited")} disabled={busy} className="cursor-pointer">
              <CheckIcon data-icon="inline-start" />
              Save Corrections
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy} className="cursor-pointer">
              Cancel
            </Button>
          </>
        ) : (
          <>
            <ButtonGroup>
              <Button size="sm" variant="outline" onClick={() => submit("approved")} disabled={busy} className="cursor-pointer hover:bg-emerald-500/8 hover:border-emerald-500/30">
                <CheckIcon data-icon="inline-start" />
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => submit("rejected")} disabled={busy} className="cursor-pointer hover:bg-rose-500/8 hover:border-rose-500/30">
                <XIcon data-icon="inline-start" />
                Reject
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy} className="cursor-pointer">
                <PencilIcon data-icon="inline-start" />
                Edit RCA
              </Button>
            </ButtonGroup>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{result.llmRequestId}</span>
          </>
        )}
      </CardFooter>
    </Card>
  )
}
