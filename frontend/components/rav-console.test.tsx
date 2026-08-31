import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "node:path"

function readFrontendFile(relativePath: string): string {
  const candidates = [
    path.resolve(relativePath),
    path.resolve("frontend", relativePath.replace(/^frontend\//, "")),
    path.resolve(__dirname, relativePath.replace(/^frontend\//, "")),
    path.resolve(__dirname, "..", relativePath.replace(/^frontend\//, "")),
    path.resolve(process.cwd(), relativePath),
    path.resolve(process.cwd(), "frontend", relativePath.replace(/^frontend\//, "")),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8")
    } catch {
      // continue
    }
  }
  return fs.readFileSync(relativePath, "utf8")
}

describe("rav-console standard English robotics navigation", () => {
  it("dashboard title is English", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain('"Fleet Overview"')
  })

  it("title map uses accurate robotics domain terms", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain('"ROSBag Registry"')
    expect(src).toContain('"Diagnostics Workspace"')
    expect(src).toContain('"Human Review"')
    expect(src).toContain('"Diagnostic Reports"')
    expect(src).toContain('"LLM Observability"')
    expect(src).toContain('"System Architecture"')
  })

  it("dataset registry uses standard English actions", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain("Diagnose Selected")
    expect(src).toContain("Upload ROSBag")
    expect(src).toContain("Filter by bag name")
  })
})

describe("analysis workspace standard English controls", () => {
  it("analysis workspace has English topic filter labels", () => {
    const src =
      readFrontendFile("frontend/components/analysis/analysis-control-bar.tsx") +
      readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain("All Topics")
  })

  it("analysis workspace time ranges are in English", () => {
    const src =
      readFrontendFile("frontend/components/analysis/analysis-control-bar.tsx") +
      readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain("Full ROSBag Run")
    expect(src).toContain("First 30 Seconds")
    expect(src).toContain("First 60 Seconds")
  })

  it("thresholds panel uses English", () => {
    const src =
      readFrontendFile("frontend/components/analysis/analysis-control-bar.tsx") +
      readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain("Frequency Gap Threshold")
  })

  it("health panels use English", () => {
    const src = readFrontendFile("frontend/components/health/analysis-health-panel.tsx")
    expect(src).toContain("Loading telemetry health scores")
    expect(src).toContain("No health summary recorded for this run")
  })
})
