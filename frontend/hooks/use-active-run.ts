"use client"

import { useEffect, useState } from "react"

import { fetcher, getAuthToken } from "@/lib/api"
import type { AnalysisRun } from "@/lib/types"

export interface ActiveJob {
  runId: string
  rosbagName: string
  stage: string
  progress: number
}

/**
 * Polls the real run list for an analysis still in flight.
 *
 * Replaces an SSE channel that served seeded random numbers from a
 * frontend-only mock store — there is no WebSocket or event stream on the
 * FastAPI side, only `GET /api/v1/runs`, so polling is what the backend can
 * actually support. `connected` means the last poll succeeded.
 */
export function useActiveRun(options?: { pollMs?: number }) {
  const pollMs = options?.pollMs ?? 5000
  const [connected, setConnected] = useState(false)
  const [job, setJob] = useState<ActiveJob | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      // `/api/v1/runs` requires auth; skip it on public pages so an anonymous
      // visitor doesn't get bounced to /login by the 401 handler.
      if (!getAuthToken()) {
        if (!cancelled) {
          setConnected(false)
          setJob(null)
        }
        return
      }
      try {
        const res = await fetcher<{ items: AnalysisRun[]; total: number }>("/api/v1/runs?limit=10")
        if (cancelled) return
        setConnected(true)
        const running = res.items.find((run) => run.status === "running" || run.status === "queued")
        setJob(
          running
            ? { runId: running.id, rosbagName: running.rosbagName, stage: running.stage, progress: running.progress }
            : null,
        )
      } catch {
        if (cancelled) return
        setConnected(false)
        setJob(null)
      }
    }

    void poll()
    const timer = setInterval(poll, pollMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pollMs])

  return { connected, job }
}
