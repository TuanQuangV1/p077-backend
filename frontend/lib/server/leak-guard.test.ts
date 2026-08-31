import { describe, expect, it } from "vitest"
import { findPromptLeaks, findSecretLeaks, responseIsSafe } from "./leak-guard"

describe("leak-guard", () => {
  it("flags OpenAI-style keys", () => {
    const leaks = findSecretLeaks("the key is sk-proj-abcdefgh1234567890abcd")
    expect(leaks).toHaveLength(1)
    expect(responseIsSafe("the key is sk-proj-abcdefgh1234567890abcd")).toBe(false)
  })

  it("flags bearer tokens and key-value secret names", () => {
    expect(findSecretLeaks("Authorization: Bearer abcdefghijklmnop")).not.toHaveLength(0)
    expect(findSecretLeaks("openai_api_key = hunter2value")).not.toHaveLength(0)
    expect(responseIsSafe("openai_api_key = hunter2value")).toBe(false)
  })

  it("flags echoed system-prompt fragments", () => {
    const sample = "Sure! You are a ROS2/Nav2 diagnostic expert analyzing a rosbag health report."
    expect(findPromptLeaks(sample)).toHaveLength(1)
    expect(responseIsSafe(sample)).toBe(false)
  })

  it("passes clean diagnostics text", () => {
    const clean = '{"summary":"/scan died at t=45","explanation":["frequency drop"],"confidence":0.8}'
    expect(findSecretLeaks(clean)).toHaveLength(0)
    expect(findPromptLeaks(clean)).toHaveLength(0)
    expect(responseIsSafe(clean)).toBe(true)
  })
})
