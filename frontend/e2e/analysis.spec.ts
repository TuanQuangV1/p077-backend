import { expect, test } from "@playwright/test"

test.setTimeout(90_000)

test("analysis workspace shows detections and timeline", async ({ page }) => {
    const windowsPromise = page.waitForResponse((r) => r.url().includes("/api/v1/analysis/") && r.url().includes("/export/windows") && r.status() === 200, { timeout: 40_000 }).catch(() => null)
    await page.goto("/analysis")

    await expect(page.getByRole("heading", { name: "Không gian phân tích" })).toBeVisible()
    await expect(page.getByText(/làn/)).toBeVisible()
    await expect(page.getByText("Phát hiện").first()).toBeVisible()
    await expect(page.getByText("Dòng thời gian tin nhắn").first()).toBeVisible()
    // Chờ window summaries và anomalies load (có thể chậm do backend phân tích)
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

    await expect(page.getByText("Nguyên nhân gốc rễ", { exact: true })).toBeVisible()
    await expect(page.getByText("Chuỗi bằng chứng", { exact: true })).toBeVisible()
    await expect(badge).not.toHaveText(initial ?? "")
})
