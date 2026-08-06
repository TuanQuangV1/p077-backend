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
      await post("/api/feedback", {
        aiResultId: result.id,
        verdict,
        editedRootCause: verdict === "edited" ? draft : undefined,
        notes,
      })
      toast.success(`Conclusion ${verdict}`, { description: result.issue })
      setEditing(false)
      onReviewed?.({
        ...result,
        reviewStatus: verdict,
        rootCause: verdict === "edited" ? draft : result.rootCause,
      })
    } catch {
      toast.error("Could not record verdict")
    } finally {
      setBusy(false)
    }
  }

  const reviewed = result.reviewStatus !== "pending"

  return (
    <Card className={cn("gap-3 py-4", compact && "border-border/70")}>
      <CardHeader className="gap-2 px-4">
        <div className="flex flex-wrap items-center gap-2">
          {anomaly ? <SeverityBadge severity={anomaly.severity} /> : null}
          <Badge variant="outline" className="gap-1 font-mono text-[10px]">
            <SparklesIcon className="size-3" />
            {result.model.replace("vllm/", "")}
          </Badge>
          {reviewed ? (
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[10px] uppercase",
                result.reviewStatus === "approved" && "border-ok/40 bg-ok/10 text-ok",
                result.reviewStatus === "rejected" && "border-critical/40 bg-critical/10 text-critical",
                result.reviewStatus === "edited" && "border-primary/40 bg-primary/10 text-primary",
              )}
            >
              {result.reviewStatus}
            </Badge>
          ) : (
            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
              pending review
            </Badge>
          )}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {ms(result.latencyMs)} · {result.promptTokens + result.completionTokens} tok
          </span>
        </div>
        <CardTitle className="text-sm leading-snug text-pretty">{result.issue}</CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Model confidence
            </span>
            <span className="font-mono text-xs tabular-nums">{(result.confidence * 100).toFixed(0)}%</span>
          </div>
          <Progress value={result.confidence * 100} className="h-1.5" />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Root cause</span>
          {editing ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`rc-${result.id}`} className="sr-only">
                  Corrected root cause
                </FieldLabel>
                <Textarea
                  id={`rc-${result.id}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  className="text-xs"
                />
                <FieldDescription className="text-[11px]">
                  Corrections are stored as labelled training data for the next fine-tune.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`nt-${result.id}`} className="text-xs">
                  Reviewer notes
                </FieldLabel>
                <Textarea
                  id={`nt-${result.id}`}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="What did the model miss?"
                  className="text-xs"
                />
              </Field>
            </FieldGroup>
          ) : (
            <p className="text-sm leading-relaxed text-pretty">{result.rootCause}</p>
          )}
        </div>

        {!compact ? (
          <p className="text-xs leading-relaxed text-muted-foreground text-pretty">{result.explanation}</p>
        ) : null}

        <Separator />

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Evidence chain
          </span>
          <ul className="flex flex-col gap-1">
            {result.evidence.map((e, i) => (
              <li key={`${e.topic}-${i}`}>
                <button
                  type="button"
                  onClick={() => onSeek?.(e.tSec)}
                  disabled={!onSeek}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left font-mono text-[11px] leading-4",
                    onSeek ? "hover:bg-accent/60" : "cursor-default",
                  )}
                >
                  <span className="w-[52px] shrink-0 tabular-nums text-primary">{clock(e.tSec)}</span>
                  <span className="w-[112px] shrink-0 truncate text-muted-foreground">{e.topic}</span>
                  <span className="min-w-0 flex-1 text-foreground/85">{e.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Suggested fix</span>
          <ol className="flex list-decimal flex-col gap-1 pl-4">
            {result.suggestedFix.map((f) => (
              <li key={f} className="text-xs leading-relaxed text-foreground/90">
                {f}
              </li>
            ))}
          </ol>
        </div>
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2 px-4">
        {editing ? (
          <>
            <Button size="sm" onClick={() => submit("edited")} disabled={busy}>
              <CheckIcon data-icon="inline-start" />
              Save correction
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <ButtonGroup>
              <Button size="sm" variant="outline" onClick={() => submit("approved")} disabled={busy}>
                <CheckIcon data-icon="inline-start" className="text-ok" />
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => submit("rejected")} disabled={busy}>
                <XIcon data-icon="inline-start" className="text-critical" />
                Reject
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
                <PencilIcon data-icon="inline-start" />
                Correct
              </Button>
            </ButtonGroup>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{result.vllmRequestId}</span>
          </>
        )}
      </CardFooter>
    </Card>
  )
}
