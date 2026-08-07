import { expect, test } from "@playwright/test"

test("human review queue renders pending conclusions", async ({ page }) => {
    await page.goto("/review")

    await expect(page.getByRole("heading", { name: "Human review queue" })).toBeVisible()
    await expect(page.getByText("pending review").first()).toBeVisible()
    // The queue exposes the three verdict actions on a review card.
    await expect(page.getByRole("button", { name: "Approve" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Reject" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Correct" }).first()).toBeVisible()
})

test("a review card shows evidence, suggested fix, and confidence", async ({ page }) => {
    await page.goto("/review")

    const card = page.locator(".group\\/card", { hasText: "pending review" }).first()
    await expect(card).toBeVisible()
    await expect(card.getByText("Root cause")).toBeVisible()
    await expect(card.getByText("Evidence chain")).toBeVisible()
    await expect(card.getByText("Suggested fix")).toBeVisible()
    await expect(card.getByText(/Model confidence/)).toBeVisible()
})