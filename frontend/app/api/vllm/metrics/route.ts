import { data } from "@/lib/server/store"
import { ok } from "@/lib/server/http"

/** GET /api/vllm/metrics?windowMin=60 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const windowMin = Number(url.searchParams.get("windowMin") ?? 60)
  const series = data().vllmSeries
  const stepSec = 20
  const keep = Math.min(series.length, Math.round((windowMin * 60) / stepSec))
  const points = series.slice(series.length - keep)
  const last = points[points.length - 1]
  const avg = (sel: (p: (typeof points)[number]) => number) =>
    Number((points.reduce((a, p) => a + sel(p), 0) / points.length).toFixed(2))

  return ok({
    points,
    current: last,
    gpu: {
      name: "NVIDIA H100 80GB HBM3",
      count: 2,
      vramTotalGb: 80,
      driver: "555.42.06",
      engine: "vLLM 0.6.3",
      maxModelLen: 8192,
      maxNumSeqs: 64,
      kvCacheUtil: Number((last.vramUsedGb / 80).toFixed(3)),
    },
    aggregates: {
      tokensPerSec: avg((p) => p.tokensPerSec),
      p50: avg((p) => p.p50),
      p95: avg((p) => p.p95),
      p99: avg((p) => p.p99),
      rps: avg((p) => p.rps),
      gpuUtil: avg((p) => p.gpuUtil),
      queueLen: avg((p) => p.queueLen),
    },
  })
}
