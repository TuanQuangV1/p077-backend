import { describe, expect, it } from "vitest"

import { resolveApiUrl } from "./api"

const BASE = "/api/v1"

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

    it("keeps the run logs route on the Next handler", () => {
        expect(resolveApiUrl("/api/runs/run_001/logs")).toBe("/api/runs/run_001/logs")
    })

    it("maps run health to the analysis health sub-resource", () => {
        expect(resolveApiUrl("/api/runs/run_001/health")).toBe(`${BASE}/analysis/run_001/health`)
    })

    it("passes unknown routes through untouched", () => {
        expect(resolveApiUrl("/api/reports")).toBe("/api/reports")
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
