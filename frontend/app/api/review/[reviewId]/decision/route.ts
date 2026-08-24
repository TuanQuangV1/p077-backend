import { backendFailure, backendPost } from "@/lib/server/backend"
import { fail, ok, readJson } from "@/lib/server/http"

/** POST /api/review/{reviewId}/decision — record a reviewer verdict. */
export async function POST(req: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params
  const body = await readJson<Record<string, unknown>>(req)
  try {
    return ok(
      await backendPost<Record<string, unknown>>(
        `/review/${encodeURIComponent(reviewId)}/decision`,
        body,
      ),
    )
  } catch (error) {
    const { message, status } = backendFailure(error)
    return fail(message, status)
  }
}
