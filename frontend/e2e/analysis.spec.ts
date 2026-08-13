import { expect, test } from "@playwright/test"

test("analysis workspace shows detections and timeline", async ({ page }) => {
    await page.goto("/analysis")

    await expect(page.getByRole("heading", { name: "Analysis workspace" })).toBeVisible()
    await expect(page.getByText(/done · 100% · \d+ lanes/)).toBeVisible()
    await expect(page.getByText("Detections").first()).toBeVisible()
    await expect(page.getByText("Message timeline").first()).toBeVisible()
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

    await expect(page.getByText("Root cause")).toBeVisible()
    await expect(page.getByText("Evidence chain")).toBeVisible()
    await expect(badge).not.toHaveText(initial ?? "")
})
