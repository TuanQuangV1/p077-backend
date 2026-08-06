import { data, submitFeedback } from "@/lib/server/store"
import { fail, ok, readJson } from "@/lib/server/http"
import type { Feedback } from "@/lib/types"

export async function GET() {
  return ok({ items: data().feedback })
}

/** POST /api/feedback — human-in-the-loop verdict on an AI conclusion. */
export async function POST(req: Request) {
  const body = await readJson<{
    aiResultId: string
    verdict: Feedback["verdict"]
    editedRootCause?: string
    notes?: string
  }>(req)
  if (!body.aiResultId || !body.verdict) return fail("aiResultId and verdict are required")
  try {
    const feedback = submitFeedback({
      aiResultId: body.aiResultId,
      verdict: body.verdict,
      editedRootCause: body.editedRootCause ?? null,
      notes: body.notes,
    })
    return ok({ feedback }, { status: 201 })
  } catch (e) {
    return fail((e as Error).message, 404)
  }
}
