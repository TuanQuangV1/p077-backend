import { expect, test } from "@playwright/test"

test("datasets table lists rosbag captures from the backend", async ({ page }) => {
    await page.goto("/datasets")

    await expect(page.getByRole("heading", { name: "Rosbag datasets" })).toBeVisible()
    await expect(page.getByText("rosbag2_2024_03_11-13_14_19_0.db3")).toBeVisible()
    await expect(page.getByText("rosbag2_2024_03_11-13_30_46_0.db3")).toBeVisible()
    await expect(page.getByText("amr-delivery").first()).toBeVisible()
    await expect(page.getByText("uploaded").first()).toBeVisible()
})

test("filter narrows the dataset table", async ({ page }) => {
    await page.goto("/datasets")

    await page.getByPlaceholder("Filter file, site, or robot type").fill("fremont-b")

    await expect(page.getByText("rosbag2_2024_03_11-13_30_46_0.db3")).toBeVisible()
    await expect(page.getByText("rosbag2_2024_03_11-13_14_19_0.db3")).toBeHidden()
})

test("datasets expose upload and delete actions", async ({ page }) => {
    await page.goto("/datasets")

    await expect(page.getByRole("button", { name: /Upload rosbag/ })).toBeVisible()
    await expect(page.getByRole("button", { name: "Analyze selected" })).toBeVisible()
    await expect(page.getByRole("button", { name: /Delete/ }).first()).toBeVisible()
})
