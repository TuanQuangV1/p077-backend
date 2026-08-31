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

/** "2026-08-12T05:04:23Z" -> "12 thg 8 12:04" for the reviewed-at badge. */
function reviewedStamp(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return d.toLocaleString("vi-VN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
}

const REVIEW_STATUS_LABEL: Record<string, string> = {
    pending: "chờ duyệt",
    approved: "đã duyệt",
    rejected: "từ chối",
    edited: "đã sửa",
}

const VERDICT_TOAST_LABEL: Record<string, string> = {
    approved: "Đã duyệt",
    rejected: "Đã từ chối",
    edited: "Đã sửa",
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
        ? `Nguyên nhân đã sửa: ${draft}${notes ? ` — ${notes}` : ""}`
        : notes || undefined
      const reviewer = getReviewer()
      const saved = await post<{ reviewer: string }>(`/api/review/${reviewId}/decision`, {
        verdict,
        reviewer,
        notes: combinedNotes,
      })
      toast.success(`Đã ghi nhận: ${VERDICT_TOAST_LABEL[verdict] ?? verdict}`, { description: result.issue })
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
      toast.error("Không thể ghi nhận quyết định")
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
            {result.model.split("/").pop() ?? result.model}
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
              {REVIEW_STATUS_LABEL[result.reviewStatus] ?? result.reviewStatus}
              {result.reviewedAt ? ` · ${reviewedStamp(result.reviewedAt)}` : ""}
              {result.reviewer ? ` · ${result.reviewer}` : ""}
            </Badge>
          ) : (
            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
              chờ duyệt
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
              Độ tin cậy AI
            </span>
            <span className="font-mono text-xs tabular-nums">{(result.confidence * 100).toFixed(0)}%</span>
          </div>
          <Progress value={result.confidence * 100} className="h-1.5" />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Nguyên nhân gốc rễ</span>
          {editing ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`rc-${result.id}`} className="sr-only">
                  Nguyên nhân đã sửa
                </FieldLabel>
                <Textarea
                  id={`rc-${result.id}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  className="text-xs"
                />
                <FieldDescription className="text-[11px]">
                  Các chỉnh sửa sẽ được lưu lại làm dữ liệu huấn luyện có nhãn cho lần tinh chỉnh tiếp theo.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`nt-${result.id}`} className="text-xs">
                  Ghi chú của người duyệt
                </FieldLabel>
                <Textarea
                  id={`nt-${result.id}`}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Mô hình AI đã bỏ sót điều gì?"
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
            Chuỗi bằng chứng
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
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Đề xuất hướng khắc phục</span>
          <ol className="flex list-decimal flex-col gap-1 pl-4">
            {result.suggestedFix.map((f) => (
              <li key={f} className="text-xs leading-relaxed text-foreground/90">
                {f}
              </li>
            ))}
          </ol>
        </div>

        {reviewed && result.reviewerNote ? (
          <div className="flex flex-col gap-1 border-l-2 border-primary/40 pl-2.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Ghi chú người duyệt
            </span>
            <p className="text-xs leading-relaxed text-foreground/85">{result.reviewerNote}</p>
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2 px-4">
        {editing ? (
          <>
            <Button size="sm" onClick={() => submit("edited")} disabled={busy}>
              <CheckIcon data-icon="inline-start" />
              Lưu chỉnh sửa
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Hủy
            </Button>
          </>
        ) : (
          <>
            <ButtonGroup>
              <Button size="sm" variant="outline" onClick={() => submit("approved")} disabled={busy}>
                <CheckIcon data-icon="inline-start" className="text-ok" />
                Phê duyệt
              </Button>
              <Button size="sm" variant="outline" onClick={() => submit("rejected")} disabled={busy}>
                <XIcon data-icon="inline-start" className="text-critical" />
                Từ chối
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
                <PencilIcon data-icon="inline-start" />
                Sửa đổi
              </Button>
            </ButtonGroup>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{result.llmRequestId}</span>
          </>
        )}
      </CardFooter>
    </Card>
  )
}
