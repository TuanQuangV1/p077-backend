import { createReport, data } from "@/lib/server/store"
import { fail, ok, readJson } from "@/lib/server/http"

export async function GET() {
  return ok({ items: data().reports })
}

/** POST /api/reports — compose a report from a finished run + approved verdicts. */
export async function POST(req: Request) {
  const body = await readJson<{ runId: string }>(req)
  if (!body.runId) return fail("runId is required")
  try {
    return ok({ report: createReport(body.runId) }, { status: 201 })
  } catch (e) {
    return fail((e as Error).message, 404)
  }
}
