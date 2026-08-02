import { afterEach, describe, expect, it, vi } from "vitest"

import type { AIResult, Anomaly, AnalysisRun, Rosbag } from "./types"
import { fetcher, post } from "./api"

const BASE = "http://localhost:8000/api/v1"

interface Overview {
    totals: Record<string, number>
    topIssues: { label: string; count: number }[]
    severity: { severity: string; count: number }[]
    trend: { date: string; bags: number; anomalies: number; p95Ms: number; costUsd: number }[]
    recentRuns: AnalysisRun[]
}

function okResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response
}

/** Routes fetch calls the way rav-console.tsx expects them, per URL. */
function routeFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
    return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const responder = routes[url]
        if (!responder) throw new Error(`No mock route for ${url}`)
        return okResponse(responder(init))
    })
}

function sampleRun(): AnalysisRun {
    return {
        id: "run_001",
        rosbagId: "bag_01",
        rosbagName: "night-shift-warehouse-042.mcap",
        robotType: "amr-delivery",
        status: "succeeded",
        progress: 100,
        stage: "done",
        startedAt: "2026-07-31T09:00:00Z",
        finishedAt: "2026-07-31T09:01:00Z",
        anomalyCount: 1,
        worstSeverity: "critical",
        model: "vllm/qwen2.5-coder-32b",
        totalLatencyMs: 3400,
        promptTokens: 1580,
        completionTokens: 644,
        costUsd: 0.12,
    }
}

describe("flow: dashboard overview", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("loads totals and recent runs from the backend", async () => {
        const run = sampleRun()
        const overview: Overview = {
            totals: { rosbags: 12, analyzed: 8, anomalies: 19, criticalOpen: 4, reviewPending: 1 },
            topIssues: [{ label: "LaserScan dropout", count: 4 }],
            severity: [{ severity: "critical", count: 4 }],
            trend: [{ date: "2026-07-31", bags: 8, anomalies: 9, p95Ms: 2800, costUsd: 0.52 }],
            recentRuns: [run],
        }
        vi.stubGlobal("fetch", routeFetch({ [`${BASE}/dashboard/overview`]: () => overview }))

        const payload = await fetcher<Overview>("/api/overview")

        expect(payload.totals.analyzed).toBe(8)
        expect(payload.recentRuns[0]).toMatchObject({ id: "run_001", status: "succeeded", anomalyCount: 1 })
        expect(payload.topIssues[0].count).toBe(4)
        expect(payload.trend[0].p95Ms).toBe(2800)
    })
})

describe("flow: datasets list", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("loads rosbag items with registry fields", async () => {
        const bags: Rosbag[] = [{
            id: "bag_01",
            name: "night-shift-warehouse-042.mcap",
            robotType: "amr-delivery",
            sizeBytes: 1_800_000_000,
            durationSec: 90,
            recordedAt: "2026-07-31T09:00:00Z",
            uploadedAt: "2026-07-31T09:00:00Z",
            status: "analyzed",
            messageCount: 124_000,
            topics: [],
            site: "Fremont-A",
            rosVersion: "ROS 2 Jazzy",
        }]
        vi.stubGlobal("fetch", routeFetch({ [`${BASE}/datasets`]: () => ({ items: bags, total: bags.length }) }))

        const payload = await fetcher<{ items: Rosbag[]; total: number }>("/api/rosbags")

        expect(payload.total).toBe(1)
        expect(payload.items[0]).toMatchObject({ id: "bag_01", status: "analyzed", site: "Fremont-A" })
        expect(payload.items[0].robotType).toBe("amr-delivery")
    })
})

describe("flow: analysis detail", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("loads anomalies and ai results for a run", async () => {
        const anomalies: Anomaly[] = [{
            id: "anomaly_001",
            runId: "run_001",
            kind: "lidar_dropout",
            title: "LaserScan dropout on /scan",
            severity: "critical",
            tSec: 14.2,
            endSec: 16.8,
            topics: ["/scan"],
            confidence: 0.91,
            metric: "0 messages for 2.20 s",
        }]
        const aiResults: AIResult[] = [{
            id: "ai_001",
            runId: "run_001",
            anomalyId: "anomaly_001",
            issue: "lidar stopped publishing",
            rootCause: "sensor VLAN packet loss",
            confidence: 0.91,
            explanation: "queue stalled",
            suggestedFix: ["Isolate sensor VLAN"],
            evidence: [{ topic: "/scan", tSec: 14.2, detail: "Zero messages" }],
            reviewStatus: "pending",
            model: "qwen2.5-coder-32b",
            latencyMs: 1600,
            promptTokens: 900,
            completionTokens: 220,
            vllmRequestId: "vllm_req_001",
        }]
        vi.stubGlobal("fetch", routeFetch({
            [`${BASE}/analysis/run_001`]: () => ({ anomalies, aiResults }),
        }))

        const payload = await fetcher<{ anomalies: Anomaly[]; aiResults: AIResult[] }>("/api/runs/run_001")

        expect(payload.anomalies[0]).toMatchObject({ id: "anomaly_001", severity: "critical", tSec: 14.2 })
        expect(payload.aiResults[0].reviewStatus).toBe("pending")
        expect(payload.aiResults[0].suggestedFix).toEqual(["Isolate sensor VLAN"])
    })
})

describe("flow: thresholds update", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("loads then saves thresholds via the direct v1 path", async () => {
        const calls: { url: string; init?: RequestInit }[] = []
        vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
            calls.push({ url, init })
            if (init?.method === "POST") {
                const body = JSON.parse(String(init.body))
                return okResponse({ thresholds: { ...body.thresholds, frequency_gap_multiplier: 1.5 } })
            }
            return okResponse({ thresholds: { frequency_gap_min_threshold_sec: 0.08, frequency_gap_multiplier: 1.5 } })
        }))

        const loaded = await fetcher<{ thresholds: Record<string, number> }>("/api/v1/analysis/thresholds")
        expect(loaded.thresholds.frequency_gap_min_threshold_sec).toBe(0.08)

        const saved = await post<{ thresholds: Record<string, number> }>("/api/v1/analysis/thresholds", {
            thresholds: { frequency_gap_min_threshold_sec: 0.05 },
        })
        expect(saved.thresholds.frequency_gap_min_threshold_sec).toBe(0.05)

        expect(calls[0].url).toBe("/api/v1/analysis/thresholds")
        expect(calls[1]).toMatchObject({ url: "/api/v1/analysis/thresholds", init: { method: "POST" } })
        expect(JSON.parse(String(calls[1].init?.body))).toEqual({ thresholds: { frequency_gap_min_threshold_sec: 0.05 } })
    })
})

describe("flow: reports generation", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("posts runId through the Next.js reports route", async () => {
        const fetchMock = routeFetch({
            "/api/reports": (init) => ({
                report: { id: "rpt_001", runId: "run_001", title: "Incident review", status: "draft" },
            }),
        })
        vi.stubGlobal("fetch", fetchMock)

        const payload = await post<{ report: { id: string; runId: string; status: string } }>("/api/reports", {
            runId: "run_001",
        })

        expect(payload.report).toMatchObject({ id: "rpt_001", runId: "run_001", status: "draft" })
        expect(fetchMock).toHaveBeenCalledWith("/api/reports", expect.objectContaining({ method: "POST" }))
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ runId: "run_001" })
    })
})
