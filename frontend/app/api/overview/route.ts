import { backendFailure, backendGet } from "@/lib/server/backend"
import { fail, ok } from "@/lib/server/http"

/** GET /api/overview — dashboard totals, trends and recent runs. */
export async function GET() {
  try {
    return ok(await backendGet<Record<string, unknown>>("/dashboard/overview"))
  } catch (error) {
    const { message, status } = backendFailure(error)
    return fail(message, status)
  }
}
