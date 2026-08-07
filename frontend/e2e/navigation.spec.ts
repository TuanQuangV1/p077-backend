import { expect, test } from "@playwright/test"

const SECTIONS: { path: string; title: string }[] = [
    { path: "/", title: "Fleet overview" },
    { path: "/datasets", title: "Rosbag datasets" },
    { path: "/analysis", title: "Analysis workspace" },
    { path: "/review", title: "Human review queue" },
    { path: "/reports", title: "Diagnostic reports" },
    { path: "/vllm", title: "VLLM observability" },
    { path: "/architecture", title: "System architecture" },
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
