import { expect, test } from "@playwright/test"

const SECTIONS: { path: string; title: string }[] = [
    { path: "/", title: "Tổng quan hạm đội" },
    { path: "/datasets", title: "Tập dữ liệu Rosbag" },
    { path: "/analysis", title: "Không gian phân tích" },
    { path: "/review", title: "Hàng đợi duyệt thủ công" },
    { path: "/reports", title: "Báo cáo chẩn đoán" },
    { path: "/vllm", title: "Giám sát vLLM" },
    { path: "/architecture", title: "Kiến trúc hệ thống" },
]

for (const { path, title } of SECTIONS) {
    test(`${path} loads without page errors`, async ({ page }) => {
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))

        await page.goto(path)
        await expect(page.getByRole("heading", { name: title })).toBeVisible()

        expect(errors).toEqual([])
    })
}
