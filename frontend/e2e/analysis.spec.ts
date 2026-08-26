import { expect, test } from "@playwright/test"

test("analysis workspace shows detections and timeline", async ({ page }) => {
    await page.goto("/analysis")

    await expect(page.getByRole("heading", { name: "Không gian phân tích" })).toBeVisible()
    await expect(page.getByText(/done · 100% · \d+ lanes/)).toBeVisible()
    await expect(page.getByText("Bất thường phát hiện").first()).toBeVisible()
    await expect(page.getByText("Trục Thời Gian Viễn Trắc").first()).toBeVisible()
    await expect(page.locator("ul li button").first()).toBeVisible()
})

test("selecting an anomaly syncs playhead and shows the agent conclusion", async ({ page }) => {
    await page.goto("/analysis")

    const badge = page.getByTestId("timeline-playhead")
    await expect(badge).toBeVisible()
    const initial = await badge.textContent()

    const anomaly = page.locator("ul li button").first()
    await expect(anomaly).toBeVisible()
    await anomaly.click()

    await expect(page.getByText("Nguyên nhân gốc rễ", { exact: true })).toBeVisible()
    await expect(page.getByText("Chuỗi bằng chứng", { exact: true })).toBeVisible()
    await expect(badge).not.toHaveText(initial ?? "")
})
