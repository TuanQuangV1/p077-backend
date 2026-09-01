import { afterEach, describe, expect, it, vi } from "vitest"

import { fetcher, post } from "./api"

function okResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function errorResponse(status: number): Response {
    return {
        ok: false,
        status,
        json: async () => ({ detail: "boom" }),
        text: async () => JSON.stringify({ detail: "boom" }),
    } as unknown as Response
}

describe("api integration", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("fetcher calls the resolved backend url", async () => {
        const fetchMock = vi.fn().mockResolvedValue(okResponse({ totals: {} }))
        vi.stubGlobal("fetch", fetchMock)

        const payload = await fetcher<{ totals: object }>("/api/overview")

        expect(payload).toEqual({ totals: {} })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledWith("/api/v1/dashboard/overview", expect.objectContaining({ headers: {} }))
    })

    it("fetcher passes through Next.js-only routes unchanged", async () => {
        const fetchMock = vi.fn().mockResolvedValue(okResponse({ logs: [] }))
        vi.stubGlobal("fetch", fetchMock)

        await fetcher("/api/runs/run_001/logs")

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/runs/run_001/logs",
            expect.objectContaining({ headers: {} }),
        )
    })

    it("post sends JSON headers and serialized body", async () => {
        const fetchMock = vi.fn().mockResolvedValue(okResponse({ run: { id: "run_001" } }))
        vi.stubGlobal("fetch", fetchMock)

        const payload = await post("/api/runs", { rosbag_id: "bag_01" })

        expect(payload).toEqual({ run: { id: "run_001" } })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledWith("/api/v1/analysis", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rosbag_id: "bag_01" }),
        })
    })

    it("throws Request failed with status on non-ok response", async () => {
        const fetchMock = vi.fn().mockResolvedValue(errorResponse(500))
        vi.stubGlobal("fetch", fetchMock)

        await expect(fetcher("/api/overview")).rejects.toThrow("Request failed: 500")
    })

    it("throws Request failed for post too", async () => {
        const fetchMock = vi.fn().mockResolvedValue(errorResponse(404))
        vi.stubGlobal("fetch", fetchMock)

        await expect(post("/api/reports", { runId: "run_001" })).rejects.toThrow("Request failed: 404")
    })
})
