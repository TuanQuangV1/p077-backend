import { expect, test } from "@playwright/test"
import path from "path"

/** A real minimal rosbag2 .db3 committed as an e2e fixture. */
const FIXTURE = path.join(__dirname, "fixtures", "trip_upload.db3")

test("upload a real .db3 through the UI and list it", async ({ page }) => {
    await page.goto("/datasets")

    await page.setInputFiles("#file-upload-input", FIXTURE)

    await expect(page.getByText("Đã tải rosbag lên").first()).toBeVisible()
    // The uploaded bag is derived from the real .db3: real message count + robot type.
    // (Re-runs dedupe the id with a suffix, so assert on content, not the name.)
    const row = page.locator("tr", { hasText: "7 messages" }).first()
    await expect(row).toBeVisible()
    await expect(row.getByText("amr-delivery")).toBeVisible()
    await expect(row.getByText("uploaded")).toBeVisible()
})