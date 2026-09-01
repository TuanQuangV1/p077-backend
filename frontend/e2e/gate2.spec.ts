import { expect, test } from "@playwright/test"
import path from "path"

const REPO_ROOT = path.resolve(__dirname, "..", "..")
const HEALTHY = path.join(REPO_ROOT, "scripts", "e2e-fixtures", "gate2", "healthy_01_0.mcap")
const ANOMALY = path.join(REPO_ROOT, "scripts", "e2e-fixtures", "gate2", "F1_02_0.mcap")
const INVALID = path.join(REPO_ROOT, "eval", "gate2", "fixtures", "not_a_rosbag.txt")

test.describe.configure({ mode: "serial" })
test.setTimeout(120_000)

async function uploadAndAnalyze(page: import("@playwright/test").Page, file: string, name: string) {
  // Xem ghi chú trong upload.spec.ts: phải chờ hydrate xong mới nạp file.
  await page.goto("/datasets", { waitUntil: "networkidle" })
  await expect(page.getByRole("button", { name: /Upload ROSBag/i })).toBeVisible()
  await page.setInputFiles("#file-upload-input", file)
  await expect(page.getByText(/ROSBag uploaded successfully|already exists/i).first()).toBeVisible()

  const row = page.locator("tr", { hasText: name }).first()
  await expect(row).toBeVisible()
  const analyzeButton = row.getByRole("button", { name: "Diagnose" })
  await analyzeButton.click()
  await expect(analyzeButton).toBeDisabled()
  await expect(page).toHaveURL(/\/analysis$/, { timeout: 60_000 })
  await expect(page.getByRole("heading", { name: "Diagnostics Workspace" })).toBeVisible()
  await expect(page.getByText(/done · 100% · \d+ lanes/)).toBeVisible({ timeout: 60_000 })
}

test("Gate 2 healthy upload renders a green result without detections", async ({ page }) => {
  await uploadAndAnalyze(page, HEALTHY, "healthy_01_0.mcap")

  // Điểm health hiển thị ở dải "Operational Reliability Scale" trong
  // health-gauge.tsx: `Index: <score> / 100`. Nhãn "HEALTH 100"/"HS 100"
  // của bản cũ không còn tồn tại trong UI.
  await expect(page.getByText(/Index:\s*100\s*\/\s*100/)).toBeVisible()
  await expect(page.getByText("0 anomalies").or(page.getByText("0 detections")).first()).toBeVisible()
  await expect(page.getByText("NOMINAL").first()).toBeVisible()
})

test("Gate 2 anomaly upload renders detection and labelled LLM fallback", async ({ page }) => {
  await uploadAndAnalyze(page, ANOMALY, "F1_02_0.mcap")

  await expect(page.getByText("Severe publish rate drop on /scan").first()).toBeVisible()
  await expect(page.getByText("LLM Synthesis Available").first()).toBeVisible()
  // Backend trả model "canned-fallback" khi LLM không tới được, nhưng UI hiển
  // thị nó thành nhãn dễ đọc (ai-conclusion.tsx:115) chứ không in chuỗi thô.
  await expect(page.getByText(/Rule-based fallback/i).first()).toBeVisible({ timeout: 30_000 })
})

test("Gate 2 invalid upload shows the backend validation error and stays usable", async ({ page }) => {
  await page.goto("/datasets", { waitUntil: "networkidle" })
  await expect(page.getByRole("button", { name: /Upload ROSBag/i })).toBeVisible()
  await page.setInputFiles("#file-upload-input", INVALID)

  await expect(page.getByText(/Upload failed.*\.txt/i)).toBeVisible()
  await expect(page.getByRole("heading", { name: "ROSBag Registry" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Upload ROSBag/ })).toBeEnabled()
})
