import { expect, test } from "@playwright/test"
import path from "path"


const REPO_ROOT = path.resolve(__dirname, "..", "..")
const HEALTHY = path.join(REPO_ROOT, "data", "dataset", "bags", "healthy", "healthy_01", "healthy_01_0.mcap")
const ANOMALY = path.join(REPO_ROOT, "data", "dataset", "bags", "faulty", "F1_02", "F1_02_0.mcap")
const INVALID = path.join(REPO_ROOT, "eval", "gate2", "fixtures", "not_a_rosbag.txt")


test.describe.configure({ mode: "serial" })
test.setTimeout(120_000)


async function uploadAndAnalyze(page: import("@playwright/test").Page, file: string, name: string) {
  await page.goto("/datasets")
  await page.setInputFiles("#file-upload-input", file)
  await expect(page.getByText("Rosbag uploaded").first()).toBeVisible()

  const row = page.locator("tr", { hasText: name }).first()
  await expect(row).toBeVisible()
  const analyzeButton = row.getByRole("button", { name: "Analyze" })
  await analyzeButton.click()
  await expect(analyzeButton).toBeDisabled()
  await expect(page).toHaveURL(/\/analysis$/, { timeout: 60_000 })
  await expect(page.getByRole("heading", { name: "Analysis workspace" })).toBeVisible()
  await expect(page.getByText(/done · 100% · \d+ lanes/)).toBeVisible({ timeout: 60_000 })
}


test("Gate 2 healthy upload renders a green result without detections", async ({ page }) => {
  await uploadAndAnalyze(page, HEALTHY, "healthy_01_0.mcap")

  await expect(page.getByText("HS 100")).toBeVisible()
  await expect(page.getByText("0 detections").first()).toBeVisible()
  await expect(page.getByText("System Healthy")).toBeVisible()
})


test("Gate 2 anomaly upload renders detection and labelled LLM fallback", async ({ page }) => {
  await uploadAndAnalyze(page, ANOMALY, "F1_02_0.mcap")

  await expect(page.getByText("Severe publish rate drop on /scan").first()).toBeVisible()
  await expect(page.getByText("LLM Analysis Available")).toBeVisible()
  await expect(page.getByText("Live LLM unavailable; showing rule-based fallback")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Health Score .*critical\/high issues/)).toBeVisible()
})


test("Gate 2 invalid upload shows the backend validation error and stays usable", async ({ page }) => {
  await page.goto("/datasets")
  await page.setInputFiles("#file-upload-input", INVALID)

  await expect(page.getByText("Upload failed: unsupported file type: .txt")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Rosbag datasets" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Upload rosbag/ })).toBeEnabled()
})
