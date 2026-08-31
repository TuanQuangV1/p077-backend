import { expect, test } from "@playwright/test"

const SECTIONS: { path: string; title: string }[] = [
    { path: "/", title: "Fleet Overview" },
    { path: "/datasets", title: "ROSBag Registry" },
    { path: "/analysis", title: "Diagnostics Workspace" },
    { path: "/review", title: "Human Review" },
    { path: "/reports", title: "Diagnostic Reports" },
    { path: "/llm", title: "LLM Observability" },
    { path: "/architecture", title: "System Architecture" },
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
