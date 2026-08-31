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

describe("rav-console i18n - Task 2", () => {
  it("dashboard title is Vietnamese", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain('"Tổng quan"')
    expect(src).not.toContain('"Fleet overview"')
  })

  it("title map is fully Vietnamese", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain('"Tập dữ liệu"')
    expect(src).toContain('"Không gian phân tích"')
    expect(src).toContain('"Hàng đợi duyệt"')
    expect(src).toContain('"Báo cáo chẩn đoán"')
    expect(src).toContain('"Giám sát LLM"')
    expect(src).toContain('"Kiến trúc hệ thống"')
    expect(src).not.toContain('"Rosbag datasets"')
    expect(src).not.toContain('"Analysis workspace"')
    expect(src).not.toContain('"Human review queue"')
    expect(src).not.toContain('"Diagnostic reports"')
    expect(src).not.toContain('"LLM observability"')
    expect(src).not.toContain('"System architecture"')
  })

  it("dataset registry is Vietnamese", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain("Phân tích mục đã chọn")
    expect(src).toContain("Tải rosbag lên")
    expect(src).toContain("Lọc theo tên tệp")
    expect(src).toContain("Không thể tải tập dữ liệu")
    expect(src).not.toContain("Capture registry")
    expect(src).not.toContain("Analyze selected")
    expect(src).not.toContain('"Upload rosbag"')
    expect(src).not.toContain("Filter file, site, or robot type")
  })
})

describe("rav-console i18n - Task 3", () => {
  it("analysis workspace has Vietnamese labels", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain("Tất cả topic")
    expect(src).not.toContain("All topics")
  })

  it("analysis workspace time ranges are Vietnamese", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain("Toàn bộ lượt chạy")
    expect(src).toContain("30 giây đầu")
    expect(src).toContain("60 giây đầu")
    expect(src).not.toContain("Full run")
    expect(src).not.toContain("First 30 sec")
    expect(src).not.toContain("First 60 sec")
  })

  it("thresholds panel is Vietnamese", () => {
    const src = readFrontendFile("frontend/components/rav-console.tsx")
    expect(src).toContain("Ngưỡng khoảng trống tần số")
    expect(src).not.toContain("Frequency gap minimum")
  })

  it("health panels are Vietnamese", () => {
    const src = readFrontendFile("frontend/components/health/analysis-health-panel.tsx")
    expect(src).toContain("Đang tải dữ liệu sức khỏe")
    expect(src).toContain("Không có dữ liệu sức khỏe")
    expect(src).not.toContain("Loading health data")
    expect(src).not.toContain("No health data available")
  })
})
