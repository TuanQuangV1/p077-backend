import { ok } from "@/lib/server/http"

/** GET /api/runs/{runId}/logs — ROS log events for a run.
 *
 * The backend exposes no raw-log endpoint yet; log *anomalies* (`log_fatal`,
 * `log_error_burst`, `log_warn_storm`) arrive with the run's detections. Answer
 * with an empty list so the console renders instead of parsing an HTML 404.
 */
export async function GET() {
  return ok({ logs: [] })
}
