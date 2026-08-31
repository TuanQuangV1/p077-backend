import { request } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"

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

async function loginAsAdmin(api: Awaited<ReturnType<typeof request.newContext>>): Promise<string> {
    const res = await api.post("/api/v1/auth/login", {
        data: { username: "admin", password: "test-pass" },
    })
    if (!res.ok()) throw new Error(`admin login failed: ${res.status()} ${await res.text()}`)
    const body = (await res.json()) as { access_token: string }
    return body.access_token
}

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
    const api = await request.newContext({ baseURL: API, timeout: 120_000 })
    let adminToken = ""
    try {
        // Login to get JWT for per-user isolation (admin owns seeded datasets)
        const token = await loginAsAdmin(api)
        adminToken = token
        const authHeaders = { Authorization: `Bearer ${token}` }

        const listRes = await api.get("/api/v1/datasets", { headers: authHeaders })
        if (!listRes.ok()) throw new Error(`datasets endpoint failed: ${listRes.status()}`)
        const { items } = (await listRes.json()) as { items: Array<{ id: string }> }
        const present = new Set(items.map((item) => item.id))
        const missing = SEED_DATASETS.filter((id) => !present.has(id))
        if (missing.length > 0) {
            throw new Error(
                `seeded datasets missing: ${missing.join(", ")} — run \`python scripts/seed_e2e.py\` first`,
            )
        }

        try {
            await api.post("/api/v1/analysis/thresholds", { data: { thresholds: { frequency_gap_min_threshold_sec: 0.08, silent_node_min_span_sec: 0.3 } } })
        } catch {
            // ignore if not supported
        }

        for (const datasetId of SEED_DATASETS) {
            const res = await api.post("/api/v1/analysis", {
                headers: authHeaders,
                data: { rosbag_id: datasetId },
            })
            if (!res.ok()) {
                throw new Error(`analysis for ${datasetId} failed: ${res.status()} ${await res.text()}`)
            }
            const body = (await res.json()) as { run: { id: string; status: string } }
            if (body.run.status !== "succeeded") {
                // waitForRun needs auth headers too
                const waitApi = await request.newContext({ baseURL: API, extraHTTPHeaders: authHeaders, timeout: 120_000 })
                try {
                    await waitForRun(waitApi, body.run.id)
                } finally {
                    await waitApi.dispose()
                }
            }
            console.log(`seeded analysis run ${body.run.id} (${body.run.status})`)
        }

        // Save storageState for authenticated e2e tests (admin) — cần cả cookie cho proxy middleware và localStorage cho lib/api
        if (adminToken) {
            const storagePath = path.join(__dirname, ".auth", "admin.json")
            await fs.promises.mkdir(path.dirname(storagePath), { recursive: true })
            const storage = {
                cookies: [
                    {
                        name: "auth_token",
                        value: adminToken,
                        domain: "localhost",
                        path: "/",
                        expires: -1,
                        httpOnly: false,
                        secure: false,
                        sameSite: "Lax",
                    },
                ],
                origins: [
                    {
                        origin: "http://localhost:3000",
                        localStorage: [{ name: "auth_token", value: adminToken }],
                    },
                ],
            }
            await fs.promises.writeFile(storagePath, JSON.stringify(storage, null, 2))
            console.log(`saved admin storageState to ${storagePath}`)
        }
    } finally {
        await api.dispose()
    }
}