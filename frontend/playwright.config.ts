import { defineConfig } from "@playwright/test"

export default defineConfig({
    testDir: "./e2e",
    globalSetup: "./e2e/global-setup.ts",
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: [["list"], ["html", { open: "never" }]],
    timeout: 30_000,
    expect: { timeout: 10_000 },
    use: {
        baseURL: "http://localhost:3000",
        trace: "on-first-retry",
    },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
    webServer: [
        {
            command: "python -m uvicorn src.main:app --port 8000",
            cwd: "../",
            url: "http://localhost:8000/health",
            timeout: 120_000,
            env: { APP_ENV: "test", OPENAI_API_KEY: "test-key" },
            reuseExistingServer: !process.env.CI,
        },
        {
            command: "pnpm dev",
            url: "http://localhost:3000",
            timeout: 120_000,
            reuseExistingServer: !process.env.CI,
        },
    ],
})
