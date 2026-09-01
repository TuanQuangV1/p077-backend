import { describe, expect, it } from "vitest"
import {
  buildTopicStats,
  computeSystemMetrics,
  formatBytes,
  formatDuration,
  isTopicHealthy,
  splitFormattedBytes,
} from "./health-engine"
import type { WindowSummaryRow } from "./api"
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

describe("buildTopicStats", () => {
  const RECORDING_SEC = 215
  const WINDOW_SEC = 5

  /** One window row, with only the fields the stats builder reads. */
  function win(topic: string, index: number, count: number, actualHz: number | null): WindowSummaryRow {
    return {
      window_start: new Date(index * WINDOW_SEC * 1000).toISOString(),
      topic,
      node: "n",
      message_type: "sensor_msgs/msg/LaserScan",
      count,
      bytes: count * 100,
      expected_hz: null,
      actual_hz: actualHz,
      max_gap_ms: null,
      jitter_ms: null,
      drift_ms: null,
    }
  }

  it("counts an outage the window rows never mention", () => {
    // Shape taken from run_F1_01_0: the LiDAR stops at t=66.8s, so /scan holds
    // 21 of the recording's 43 windows and every surviving window still reads a
    // clean ~10Hz. Averaging the rows that exist rated this NOMINAL at a 10%
    // drop while the topic had lost 61% of its messages.
    const rows = Array.from({ length: 21 }, (_, i) => win("/scan", i, 45, 10.0))

    const [scan] = buildTopicStats(rows, RECORDING_SEC, WINDOW_SEC)

    expect(scan.expectedHz).toBe(10)
    expect(scan.hz).toBeCloseTo((21 * 45) / RECORDING_SEC, 2)
    expect(scan.dropRate).toBeGreaterThan(0.5)
    expect(isTopicHealthy(scan)).toBe(false)
  })

  it("does not invent a drop on a topic that never missed a window", () => {
    // A steady topic present in every window must not be penalised by one
    // burst window reading high: taking the max as nominal invented a 24% drop
    // on /imu and 11% on /tf, neither of which the detector flagged.
    const rows = Array.from({ length: 43 }, (_, i) => win("/imu", i, 1000, i === 7 ? 260 : 200))

    const [imu] = buildTopicStats(rows, RECORDING_SEC, WINDOW_SEC)

    expect(imu.expectedHz).toBe(200)
    expect(imu.dropRate).toBeLessThan(0.05)
    expect(isTopicHealthy(imu)).toBe(true)
  })

  it("ignores null rates instead of averaging them in as zero", () => {
    // `actual_hz` is null when a window holds fewer than 2 messages. Summing
    // those as 0 pushed /amcl_pose past the drop threshold on its own.
    const rows = [...Array.from({ length: 20 }, (_, i) => win("/amcl_pose", i, 15, 3.0)), win("/amcl_pose", 20, 1, null)]

    const [pose] = buildTopicStats(rows, RECORDING_SEC, WINDOW_SEC)

    expect(pose.expectedHz).toBe(3)
    expect(pose.messageCount).toBe(20 * 15 + 1)
  })

  it("ranks the topic that lost the most messages worst", () => {
    // The table's ranking must agree with the detector: on run_F1_01_0 the
    // silent LiDAR has to outrank topics that merely ran slightly slow.
    const rows = [
      ...Array.from({ length: 21 }, (_, i) => win("/scan", i, 45, 10.0)),
      ...Array.from({ length: 43 }, (_, i) => win("/tf", i, 350, 70.0)),
    ]

    const stats = buildTopicStats(rows, RECORDING_SEC, WINDOW_SEC)
    const worst = [...stats].sort((a, b) => b.dropRate - a.dropRate)[0]

    expect(worst.name).toBe("/scan")
  })

  it("falls back to the window span when the bag duration is unknown", () => {
    const rows = Array.from({ length: 10 }, (_, i) => win("/scan", i, 50, 10.0))

    const [scan] = buildTopicStats(rows, 0, WINDOW_SEC)

    expect(scan.hz).toBeCloseTo(500 / (10 * WINDOW_SEC), 2)
  })
})
