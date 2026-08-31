import { expect, test } from "@playwright/test"

test("loads, edits, and saves diagnostics thresholds", async ({ page }) => {
    const thresholdsLoaded = page.waitForResponse(
        (r) => r.url().includes("/api/v1/analysis/thresholds") && r.request().method() === "GET",
    )
    await page.goto("/analysis")
    await thresholdsLoaded

    const panel = page.getByTestId("thresholds-panel")
    await expect(panel).toBeVisible()

    const gap = page.getByTestId("threshold-frequency-gap")
    await expect(gap).toHaveValue("0.08")

    await gap.fill("0.05")
    await page.getByTestId("save-thresholds").click()

    await expect(page.getByText(/Threshold configuration updated|Thresholds saved/i)).toBeVisible()
    await expect(gap).toHaveValue("0.05")

    await gap.fill("0.08")
    await page.getByTestId("save-thresholds").click()
    await expect(gap).toHaveValue("0.08")
})
