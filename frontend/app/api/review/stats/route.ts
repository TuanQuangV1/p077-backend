import { backendFailure, backendGet } from "@/lib/server/backend"
import { fail, ok } from "@/lib/server/http"

/** GET /api/review/stats — human-review verdict tallies. */
export async function GET() {
  try {
    return ok(await backendGet<Record<string, unknown>>("/review/stats"))
  } catch (error) {
    const { message, status } = backendFailure(error)
    return fail(message, status)
  }
}
