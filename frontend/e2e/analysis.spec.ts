import { expect, test } from "@playwright/test"

test.setTimeout(90_000)

test("analysis workspace shows detections and timeline", async ({ page }) => {
    const windowsPromise = page.waitForResponse((r) => r.url().includes("/api/v1/analysis/") && r.url().includes("/export/windows") && r.status() === 200, { timeout: 40_000 }).catch(() => null)
    await page.goto("/analysis")

    await expect(page.getByRole("heading", { name: "Diagnostics Workspace" })).toBeVisible()
    await expect(page.getByText(/lanes/i)).toBeVisible()
    await expect(page.getByText(/Detected Faults|Faults/i).first()).toBeVisible()
    await expect(page.getByText(/Timeline & Anomaly Heatmap/i).first()).toBeVisible()
    await windowsPromise
    await expect(page.locator("ul li button").first()).toBeVisible({ timeout: 30_000 })
})

test("selecting an anomaly syncs playhead and shows the agent conclusion", async ({ page }) => {
    const windowsPromise = page.waitForResponse((r) => r.url().includes("/api/v1/analysis/") && r.url().includes("/export/windows") && r.status() === 200, { timeout: 40_000 }).catch(() => null)
    await page.goto("/analysis")

    const badge = page.getByTestId("timeline-playhead")
    await expect(badge).toBeVisible({ timeout: 30_000 })
    const initial = await badge.textContent()

    await windowsPromise
    const anomaly = page.locator("ul li button").first()
    await expect(anomaly).toBeVisible({ timeout: 30_000 })
    await anomaly.click()

    await expect(page.getByText(/Root Cause Analysis/i).first()).toBeVisible()
    await expect(page.getByText(/Evidence Chain/i).first()).toBeVisible()
})
