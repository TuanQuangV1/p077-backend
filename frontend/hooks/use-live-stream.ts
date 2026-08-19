"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Single subscription point for the live channel.
 *
 * Today this reads SSE from `/api/stream`. Against the FastAPI backend the
 * same envelope arrives over a WebSocket at `/ws?topics=...`; swapping
 * transports only touches this file because every consumer sees the same shape.
 */
export interface JobProgress {
  runId: string
  rosbagName: string
  stage: string
  progress: number
  message: string
}

export interface LiveLog {
  id: string
  runId: string
  tSec: number
  level: string
  node: string
  message: string
}

export interface VllmTick {
  tokensPerSec: number
  gpuUtil: number
  queueLen: number
  batchSize: number
  p95: number
  ts: string
}

export function useLiveStream(options?: { paused?: boolean; logLimit?: number; tickLimit?: number }) {
  const paused = options?.paused ?? false
  const logLimit = options?.logLimit ?? 120
  const tickLimit = options?.tickLimit ?? 60

  const [connected, setConnected] = useState(false)
  const [job, setJob] = useState<JobProgress | null>(null)
  const [logs, setLogs] = useState<LiveLog[]>([])
  const [ticks, setTicks] = useState<VllmTick[]>([])
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const es = new EventSource("/api/stream")
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      if (pausedRef.current) return
      let evt: { type: string; ts: string; payload: Record<string, unknown> }
      try {
        evt = JSON.parse(e.data)
      } catch {
        return
      }
      if (evt.type === "job.progress") {
        setJob(evt.payload as unknown as JobProgress)
      } else if (evt.type === "log") {
        const log = evt.payload as unknown as LiveLog
        setLogs((prev) => [...prev.slice(-(logLimit - 1)), log])
      } else if (evt.type === "vllm.tick") {
        const tick = { ...(evt.payload as unknown as VllmTick), ts: evt.ts }
        setTicks((prev) => [...prev.slice(-(tickLimit - 1)), tick])
      }
    }
    return () => es.close()
  }, [logLimit, tickLimit])

  return { connected, job, logs, ticks }
}
