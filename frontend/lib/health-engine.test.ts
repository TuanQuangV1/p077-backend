import { describe, expect, it } from "vitest"
import {
  computeSystemMetrics,
  formatBytes,
  formatDuration,
  isTopicHealthy,
  splitFormattedBytes,
} from "./health-engine"
import type { Anomaly, Rosbag, TopicStat } from "./types"

describe("health-engine", () => {
  it("formats bytes correctly", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1024 * 1024 * 8)).toBe("8.0 MB")

    expect(splitFormattedBytes(0)).toEqual({ value: "0", unit: "B" })
    expect(splitFormattedBytes(1024 * 1024 * 37.2)).toEqual({ value: "37.2", unit: "MB" })
  })

  it("formats durations correctly", () => {
    expect(formatDuration(0)).toBe("0:00")
    expect(formatDuration(65)).toBe("1:05")
    expect(formatDuration(241)).toBe("4:01")
    expect(formatDuration(3665)).toBe("1:01:05")
  })

  it("evaluates topic health correctly including static topics", () => {
    const staticTopic: TopicStat = {
      name: "/tf_static",
      messageType: "tf2_msgs/msg/TFMessage",
      messageCount: 1,
      hz: 0,
      expectedHz: 0,
      dropRate: 0,
    }
    expect(isTopicHealthy(staticTopic)).toBe(true)

    const deadTopic: TopicStat = {
      name: "/cmd_vel",
      messageType: "geometry_msgs/msg/Twist",
      messageCount: 0,
      hz: 0,
      expectedHz: 20,
      dropRate: 1,
    }
    expect(isTopicHealthy(deadTopic)).toBe(false)
  })

  it("computes comprehensive system metrics dynamically", () => {
    const sampleBag: Rosbag = {
      id: "run-1",
      name: "test.db3",
      robotType: "amr-delivery",
      sizeBytes: 8388608, // 8.0 MB
      durationSec: 241,
      recordedAt: "2026-08-23T00:00:00Z",
      uploadedAt: "2026-08-23T00:00:00Z",
      status: "analyzed",
      messageCount: 83765,
      topics: [],
      site: "factory-a",
      rosVersion: "ros2-humble",
    }

    const sampleTopics: TopicStat[] = [
      { name: "/imu", messageType: "sensor_msgs/msg/Imu", messageCount: 48000, hz: 200, expectedHz: 200, dropRate: 0 },
      { name: "/scan", messageType: "sensor_msgs/msg/LaserScan", messageCount: 2400, hz: 10, expectedHz: 20, dropRate: 0.5 },
      { name: "/tf_static", messageType: "tf2_msgs/msg/TFMessage", messageCount: 1, hz: 0, expectedHz: 0, dropRate: 0 },
      { name: "/cmd_vel", messageType: "geometry_msgs/msg/Twist", messageCount: 0, hz: 0, expectedHz: 20, dropRate: 1 },
    ]

    const sampleAnomalies: Anomaly[] = [
      { id: "a-1", runId: "run-1", kind: "silent_node", title: "Silent cmd_vel", severity: "critical", tSec: 0, endSec: 10, topics: ["/cmd_vel"], confidence: 0.9, metric: "hz" },
      { id: "a-2", runId: "run-1", kind: "timestamp_jitter", title: "Latency Jitter", severity: "medium", tSec: 5, endSec: 15, topics: ["/imu"], confidence: 0.8, metric: "jitter" },
    ]

    const metrics = computeSystemMetrics({
      rosbag: sampleBag,
      topics: sampleTopics,
      anomalies: sampleAnomalies,
    })

    expect(metrics.formattedDuration).toBe("4:01")
    expect(metrics.formattedTotalSize).toBe("8.0 MB")
    expect(metrics.avgRateHz).toBeCloseTo(347.57, 1)
    expect(metrics.totalTopics).toBe(4)
    expect(metrics.healthyTopicsCount).toBe(2) // /imu and /tf_static
    expect(metrics.problematicTopicsCount).toBe(2) // /scan and /cmd_vel
    expect(metrics.silentTopicsCount).toBe(1) // /cmd_vel
    expect(metrics.sensorAvailabilityPct).toBe(50)
    expect(metrics.criticalCount).toBe(1)
    expect(metrics.mediumCount).toBe(1)
  })
})
