import { request } from "@playwright/test"

/**
 * Seeds persisted analysis runs before the suite starts.
 *
 * `scripts/seed_e2e.py` (run by the CI job / developer) writes the synthetic
 * bags into `data/`; the webServer has already started the backend on :8000.
 * This setup kicks off a real analysis for the two seeded datasets so the
 * dashboard, datasets, analysis and human-review specs observe actual runs,
 * detections, AI conclusions and pending review items.
 */
const API = "http://localhost:8000"
const SEED_DATASETS = ["h01", "f02"]

async function waitForRun(api: Awaited<ReturnType<typeof request.newContext>>, runId: string): Promise<void> {
    const deadline = Date.now() + 120_000
    for (;;) {
        const res = await api.get(`/api/v1/analysis/${runId}`)
        if (!res.ok()) throw new Error(`run ${runId} lookup failed: ${res.status()}`)
        const body = (await res.json()) as { run: { status: string } }
        if (body.run.status === "succeeded") return
        if (body.run.status === "failed") throw new Error(`run ${runId} failed`)
        if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in time`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
}

export default async function globalSetup(): Promise<void> {
    const api = await request.newContext({ baseURL: API })
    try {
        const listRes = await api.get("/api/v1/datasets")
        if (!listRes.ok()) throw new Error(`datasets endpoint failed: ${listRes.status()}`)
        const { items } = (await listRes.json()) as { items: Array<{ id: string }> }
        const present = new Set(items.map((item) => item.id))
        const missing = SEED_DATASETS.filter((id) => !present.has(id))
        if (missing.length > 0) {
            throw new Error(
                `seeded datasets missing: ${missing.join(", ")} — run \`python scripts/seed_e2e.py\` first`,
            )
        }

        for (const datasetId of SEED_DATASETS) {
            const res = await api.post("/api/v1/analysis", { data: { rosbag_id: datasetId } })
            if (!res.ok()) {
                throw new Error(`analysis for ${datasetId} failed: ${res.status()} ${await res.text()}`)
            }
            const body = (await res.json()) as { run: { id: string; status: string } }
            if (body.run.status !== "succeeded") await waitForRun(api, body.run.id)
            console.log(`seeded analysis run ${body.run.id} (${body.run.status})`)
        }
    } finally {
        await api.dispose()
    }
}