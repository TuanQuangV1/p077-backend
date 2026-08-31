import { expect, test } from "@playwright/test"
import path from "path"

/** A real minimal rosbag2 .db3 committed as an e2e fixture. */
const FIXTURE = path.join(__dirname, "fixtures", "trip_upload.db3")

test("upload a real .db3 through the UI and list it", async ({ page }) => {
    await page.goto("/datasets")

    await page.setInputFiles("#file-upload-input", FIXTURE)

    await expect(page.getByText(/ROSBag uploaded successfully|already exists/i).first()).toBeVisible()
    const row = page.locator("tr", { hasText: "7 messages" }).first()
    await expect(row).toBeVisible()
    await expect(row.getByText("amr-delivery")).toBeVisible()
})