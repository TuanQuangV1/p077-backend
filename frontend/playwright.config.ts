import { defineConfig } from "@playwright/test"
import { existsSync } from "fs"
import path from "path"

// Đường dẫn interpreter phải chạy được trên cả Windows lẫn Linux: bản cũ ghi
// cứng `.venv\Scripts\python` nên job e2e không bao giờ khởi động nổi backend
// trên CI Linux. Dùng venv của repo khi có, ngược lại rơi về `python` trên PATH
// (trường hợp CI cài deps bằng actions/setup-python). Ghi đè được bằng $PYTHON.
const repoRoot = path.resolve(__dirname, "..")
const venvPython =
    process.platform === "win32"
        ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
        : path.join(repoRoot, ".venv", "bin", "python")
const PYTHON = process.env.PYTHON ?? (existsSync(venvPython) ? venvPython : "python")

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
        storageState: "e2e/.auth/admin.json",
    },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
    webServer: [
        {
            command: `${PYTHON} -m uvicorn src.main:app --port 8000`,
            cwd: "../",
            url: "http://localhost:8000/health",
            timeout: 120_000,
            env: {
                APP_ENV: "test",
                OPENAI_API_KEY: "test-key",
                JWT_SECRET: "test-e2e-jwt-secret-32-chars-min-for-playwright",
                AUTH_USERNAME: "admin",
                AUTH_PASSWORD: "test-pass",
                JWT_EXPIRE_MINUTES: "60",
                LOGIN_RATE_LIMIT_MAX: "100",
                LOGIN_RATE_LIMIT_WINDOW_SEC: "60",
            },
            reuseExistingServer: !process.env.CI,
        },
        {
            command: "pnpm dev",
            url: "http://localhost:3000",
            timeout: 180_000,
            reuseExistingServer: !process.env.CI,
        },
    ],
})
