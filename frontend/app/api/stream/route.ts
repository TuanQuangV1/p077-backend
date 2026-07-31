import { data } from "@/lib/server/store"

/**
 * GET /api/stream — Server-Sent Events channel.
 *
 * The FastAPI backend exposes the same payloads over a WebSocket
 * (`/ws?topics=jobs,logs,vllm`). SSE is used here because it is the
 * transport that works unchanged on Vercel's serverless runtime, and the
 * event envelope is identical, so swapping the transport is a one-file change
 * in `hooks/use-live-stream.ts`.
 *
 * Envelope: { type, ts, payload }
 *   job.progress  { runId, stage, progress, message }
 *   log           { runId, tSec, level, node, message }
 *   vllm.tick     { tokensPerSec, gpuUtil, queueLen, batchSize, p95 }
 */
export const dynamic = "force-dynamic"

const STAGES = ["parse", "index", "detect", "diagnose", "report"] as const

export async function GET(req: Request) {
  const d = data()
  const activeRun = d.runs.find((r) => r.status === "running") ?? d.runs[0]
  const logPool = d.logs.filter((l) => l.runId === activeRun?.id).slice(0, 400)

  const encoder = new TextEncoder()
  let tick = 0
  let progress = activeRun?.progress ?? 40
  let timer: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream({
    start(controller) {
      const send = (type: string, payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type, ts: new Date().toISOString(), payload })}\n\n`),
        )
      }

      const emit = () => {
        tick++
        const jitter = (n: number) => n * (0.9 + Math.random() * 0.2)

        send("vllm.tick", {
          tokensPerSec: Math.round(jitter(1180)),
          gpuUtil: Number(jitter(76).toFixed(1)),
          queueLen: Math.round(jitter(7)),
          batchSize: Math.round(jitter(18)),
          p95: Math.round(jitter(640)),
        })

        if (activeRun) {
          progress = Math.min(99, progress + Math.random() * 4)
          send("job.progress", {
            runId: activeRun.id,
            rosbagName: activeRun.rosbagName,
            stage: STAGES[Math.min(STAGES.length - 1, Math.floor((progress / 100) * STAGES.length))],
            progress: Number(progress.toFixed(1)),
            message: `agent step ${tick}: correlating ${activeRun.rosbagName.slice(0, 18)}`,
          })
        }

        if (logPool.length) {
          const l = logPool[(tick * 7) % logPool.length]
          send("log", {
            runId: l.runId,
            tSec: l.tSec,
            level: l.level,
            node: l.node,
            topic: l.topic,
            message: l.message,
          })
        }
      }

      emit()
      timer = setInterval(emit, 1600)
      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
    cancel() {
      if (timer) clearInterval(timer)
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
