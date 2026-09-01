import { expect, test } from "@playwright/test"

test("dashboard renders stat tiles and recent runs", async ({ page }) => {
    const overviewResponse = page.waitForResponse((response) =>
        response.url().includes("/api/v1/dashboard/overview") && response.status() === 200,
    )
    await page.goto("/")
    const overview = await (await overviewResponse).json() as { recentRuns: Array<{ rosbagName: string }> }

    await expect(page.getByRole("heading", { name: "Fleet Overview" })).toBeVisible()
    for (const label of ["ROSBags Ingested", "Faulty Run Ratio", "Mean Time to Diagnose", "AI Inference Cost"]) {
        await expect(page.getByText(label).first()).toBeVisible()
    }

    await expect(page.getByText("Recent Diagnostic Runs").first()).toBeVisible()
    if (overview.recentRuns.length > 0) {
        await expect(page.getByText(overview.recentRuns[0].rosbagName).first()).toBeVisible()
    }
})

test("dashboard exposes the full sidebar navigation", async ({ page }) => {
    await page.goto("/")

    // Nguồn sự thật: NAV trong frontend/components/app-sidebar.tsx
    for (const label of [
        "Fleet Overview",
        "ROSBag Registry",
        "Diagnostics Workspace",
        "Human Review",
        "LLM Observability",
        "Diagnostic Reports",
        "System Architecture",
    ]) {
        await expect(page.getByRole("link", { name: label })).toBeVisible()
    }
})
