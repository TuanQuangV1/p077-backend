import { expect, test } from "@playwright/test"

test("datasets table lists rosbag captures from the backend", async ({ page }) => {
    const datasetsResponse = page.waitForResponse((response) =>
        response.url().includes("/api/v1/datasets") && response.request().method() === "GET",
    )
    await page.goto("/datasets")
    const payload = await (await datasetsResponse).json() as { items: Array<{ name: string; robotType: string; status: string }> }

    await expect(page.getByRole("heading", { name: "ROSBag Registry" })).toBeVisible()
    expect(payload.items.length).toBeGreaterThan(0)
    await expect(page.getByText(payload.items[0].name).first()).toBeVisible()
    await expect(page.getByText(payload.items[0].robotType).first()).toBeVisible()
})

test("filter narrows the dataset table", async ({ page }) => {
    const datasetsResponse = page.waitForResponse((response) =>
        response.url().includes("/api/v1/datasets") && response.request().method() === "GET",
    )
    await page.goto("/datasets")
    const payload = await (await datasetsResponse).json() as { items: Array<{ name: string }> }
    const names = [...new Set(payload.items.map((item) => item.name))]
    expect(names.length).toBeGreaterThan(1)

    await page.getByPlaceholder(/Search by bag name|Filter by bag/i).fill(names[0])

    await expect(page.getByText(names[0]).first()).toBeVisible()
    await expect(page.getByText(names[1]).first()).toBeHidden()
})

test("datasets expose upload and delete actions", async ({ page }) => {
    await page.goto("/datasets")

    await expect(page.getByRole("button", { name: /Upload ROSBag/i })).toBeVisible()
    await expect(page.getByRole("button", { name: /Diagnose Selected/i })).toBeVisible()
    await expect(page.getByRole("button", { name: /Delete/i }).first()).toBeVisible()
})
