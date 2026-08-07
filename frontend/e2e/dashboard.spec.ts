import { expect, test } from "@playwright/test"

test("dashboard renders stat tiles and recent runs", async ({ page }) => {
    await page.goto("/")

    await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible()
    for (const label of ["Rosbags processed", "Runs with errors", "Mean diagnosis", "Inference cost"]) {
        await expect(page.getByText(label)).toBeVisible()
    }

    await expect(page.getByText("Recent runs").first()).toBeVisible()
    await expect(page.getByText("night-shift-warehouse-042.mcap")).toBeVisible()
})

test("dashboard exposes the full sidebar navigation", async ({ page }) => {
    await page.goto("/")

    for (const label of [
        "Dashboard",
        "Datasets",
        "Analysis",
        "Human Review",
        "VLLM Monitoring",
        "Reports",
        "Architecture",
    ]) {
        await expect(page.getByRole("link", { name: label })).toBeVisible()
    }
})
