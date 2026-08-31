import { expect, test } from "@playwright/test"

test("dashboard renders stat tiles and recent runs", async ({ page }) => {
    const overviewResponse = page.waitForResponse((response) =>
        response.url().includes("/api/v1/dashboard/overview") && response.status() === 200,
    )
    await page.goto("/")
    const overview = await (await overviewResponse).json() as { recentRuns: Array<{ rosbagName: string }> }

    await expect(page.getByRole("heading", { name: "Tổng quan" })).toBeVisible()
    for (const label of ["Tệp Rosbag đã phân tích", "Tỷ lệ lượt chạy có lỗi", "Thời gian chẩn đoán TB", "Chi phí suy luận AI"]) {
        await expect(page.getByText(label)).toBeVisible()
    }

    await expect(page.getByText("Lượt chạy gần đây").first()).toBeVisible()
    if (overview.recentRuns.length > 0) {
        await expect(page.getByText(overview.recentRuns[0].rosbagName).first()).toBeVisible()
    }
})

test("dashboard exposes the full sidebar navigation", async ({ page }) => {
    await page.goto("/")

    for (const label of [
        "Tổng quan",
        "Tập dữ liệu",
        "Phân tích",
        "Duyệt thủ công",
        "Giám sát LLM",
        "Báo cáo",
        "Kiến trúc",
    ]) {
        await expect(page.getByRole("link", { name: label })).toBeVisible()
    }
})
