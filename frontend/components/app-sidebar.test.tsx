import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "node:path"

function readFrontendFile(relativePath: string): string {
  // Try multiple base paths to handle both frontend/ and project-root CWD
  const candidates = [
    path.resolve(relativePath),
    path.resolve("frontend", relativePath.replace(/^frontend\//, "")),
    path.resolve(__dirname, "..", relativePath.replace(/^frontend\//, "")),
    path.resolve(__dirname, relativePath),
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
  // fallback: try direct read as in brief
  return fs.readFileSync(relativePath, "utf8")
}

describe("layout lang", () => {
  it("html lang is vi", () => {
    const src = readFrontendFile("frontend/app/layout.tsx")
    expect(src).toContain('lang="vi"')
    expect(src).not.toContain('lang="en"')
  })
})
