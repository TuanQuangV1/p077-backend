import { expect, test } from "@playwright/test"

test("human review queue renders pending conclusions", async ({ page }) => {
    await page.goto("/review")

    await expect(page.getByRole("heading", { name: "Hàng đợi duyệt thủ công" })).toBeVisible()
    await expect(page.getByText("chờ duyệt").first()).toBeVisible()
    // The queue exposes the three verdict actions on a review card.
    await expect(page.getByRole("button", { name: "Phê duyệt" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Từ chối" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Chỉnh sửa" }).first()).toBeVisible()
})

test("a review card shows evidence, suggested fix, and confidence", async ({ page }) => {
    await page.goto("/review")

    const card = page.locator(".group\\/card", { hasText: "chờ duyệt" }).first()
    await expect(card).toBeVisible()
    await expect(card.getByText("Nguyên nhân gốc rễ")).toBeVisible()
    await expect(card.getByText("Chuỗi bằng chứng")).toBeVisible()
    await expect(card.getByText("Đề xuất hướng khắc phục")).toBeVisible()
    await expect(card.getByText(/Độ tin cậy của AI/)).toBeVisible()
})