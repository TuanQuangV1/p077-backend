import { expect, test } from "@playwright/test"

test("datasets table lists rosbag captures from the backend", async ({ page }) => {
    await page.goto("/datasets")

    await expect(page.getByRole("heading", { name: "Rosbag datasets" })).toBeVisible()
    await expect(page.getByText("night-shift-warehouse-042.mcap")).toBeVisible()
    await expect(page.getByText("rotterdam-hub-011.mcap")).toBeVisible()
    await expect(page.getByText("amr-delivery")).toBeVisible()
    await expect(page.getByText("analyzed")).toBeVisible()
    await expect(page.getByText("uploaded")).toBeVisible()
})

test("filter narrows the dataset table", async ({ page }) => {
    await page.goto("/datasets")

    await page.getByPlaceholder("Filter file, site, or robot type").fill("rotterdam")

    await expect(page.getByText("rotterdam-hub-011.mcap")).toBeVisible()
    await expect(page.getByText("night-shift-warehouse-042.mcap")).toBeHidden()
})
