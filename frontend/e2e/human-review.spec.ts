import { expect, test } from "@playwright/test"

test("human review queue renders pending conclusions", async ({ page }) => {
    await page.goto("/review")

    await expect(page.getByRole("heading", { name: "Human Review" })).toBeVisible()
    await expect(page.getByText(/Pending Review|pending/i).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Approve" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Reject" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Edit Root Cause" }).first()).toBeVisible()
})

test("a review card shows evidence, suggested fix, and confidence", async ({ page }) => {
    await page.goto("/review")

    const card = page.locator(".group\\/card").first()
    await expect(card).toBeVisible()
    await expect(card.getByText("Root Cause Analysis")).toBeVisible()
    await expect(card.getByText("Evidence Chain (Telemetry Timestamps)")).toBeVisible()
    await expect(card.getByText("Recommended Remediation")).toBeVisible()
    await expect(card.getByText(/Diagnostic Confidence/)).toBeVisible()
})