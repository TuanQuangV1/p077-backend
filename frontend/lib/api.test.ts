import { describe, expect, it } from "vitest"

import { resolveApiUrl } from "./api"

const BASE = "http://localhost:8000/api/v1"

describe("resolveApiUrl", () => {
    it("maps dashboard overview to backend endpoint", () => {
        expect(resolveApiUrl("/api/overview")).toBe(`${BASE}/dashboard/overview`)
    })

    it("maps rosbag list to datasets endpoint", () => {
        expect(resolveApiUrl("/api/rosbags")).toBe(`${BASE}/datasets`)
    })

    it("maps runs list to analysis endpoint", () => {
        expect(resolveApiUrl("/api/runs")).toBe(`${BASE}/analysis`)
    })

    it("maps diagnostics explanation to the backend LLM endpoint", () => {
        expect(resolveApiUrl("/api/analysis/explain")).toBe(`${BASE}/analysis/explain`)
    })

    it("maps run detail to analysis detail endpoint", () => {
        expect(resolveApiUrl("/api/runs/run_001")).toBe(`${BASE}/analysis/run_001`)
    })

    it("maps review queue to review endpoint", () => {
        expect(resolveApiUrl("/api/review")).toBe(`${BASE}/review`)
    })

    it("maps review decision to review decision endpoint", () => {
        expect(resolveApiUrl("/api/review/abc/decision")).toBe(`${BASE}/review/abc/decision`)
    })

    it("passes through run timeline with query string", () => {
        expect(resolveApiUrl("/api/runs/run_001/timeline?from=0")).toBe("/api/runs/run_001/timeline?from=0")
    })

    it("passes through run simulation", () => {
        expect(resolveApiUrl("/api/runs/run_001/simulation")).toBe("/api/runs/run_001/simulation")
    })

    it("passes through run ai route", () => {
        expect(resolveApiUrl("/api/runs/run_001/ai")).toBe("/api/runs/run_001/ai")
    })

    it("passes through reports", () => {
        expect(resolveApiUrl("/api/reports")).toBe("/api/reports")
    })

    it("passes through stream", () => {
        expect(resolveApiUrl("/api/stream")).toBe("/api/stream")
    })

    it("passes through vllm routes", () => {
        expect(resolveApiUrl("/api/vllm/metrics?windowMin=60")).toBe("/api/vllm/metrics?windowMin=60")
    })

    it("passes through direct backend v1 paths", () => {
        expect(resolveApiUrl("/api/v1/analysis/thresholds")).toBe("/api/v1/analysis/thresholds")
    })

    it("maps rosbag delete to dataset endpoint", () => {
        expect(resolveApiUrl("/api/rosbags/bag_01")).toBe(`${BASE}/datasets/bag_01`)
    })

    it("passes through non-api urls untouched", () => {
        expect(resolveApiUrl("http://localhost:8000/api/v1/health")).toBe("http://localhost:8000/api/v1/health")
    })
})
