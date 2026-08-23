/**
 * Calculation Engine for Rosbag Health & Diagnostics Metrics.
 *
 * Provides generic, formula-driven calculations for any rosbag recording,
 * avoiding hardcoded assumptions and preventing dashboard metric duplications.
 */

import type { Anomaly, HealthSummary, LogEvent, Rosbag, TopicStat } from "./types"

export interface SystemMetrics {
  // Card 1: System Message Rate
  avgRateHz: number
  formattedAvgRateHz: string
  rateSubtext: string

  // Card 2: Total Volume & Bandwidth Throughput
  totalSizeBytes: number
  formattedTotalSize: string
  sizeValue: string
  sizeUnit: string
  avgBandwidthBps: number
  formattedBandwidth: string
  bandwidthValue: string
  bandwidthUnit: string
  bandwidthSubtext: string

  // Card 3: Sensor Availability & Integrity
  totalTopics: number
  healthyTopicsCount: number
  problematicTopicsCount: number
  silentTopicsCount: number
  sensorAvailabilityPct: number
  availabilityStatus: "healthy" | "degraded" | "critical"
  availabilitySubtext: string

  // Card 4: Duration
  durationSec: number
  formattedDuration: string
  durationSubtext: string

  // Card 5: Message Count
  totalMessages: number
  formattedMessages: string
  messagesSubtext: string

  // Detections & Anomaly Breakdown
  totalDetections: number
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0 || isNaN(bytes)) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

export function splitFormattedBytes(bytes: number): { value: string; unit: string } {
  if (bytes <= 0 || isNaN(bytes)) return { value: "0", unit: "B" }
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const val = (bytes / Math.pow(k, i)).toFixed(1)
  return { value: val, unit: sizes[i] }
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0 || isNaN(seconds)) return "0:00"
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const hours = Math.floor(mins / 60)

  if (hours > 0) {
    const remainMins = mins % 60
    return `${hours}:${String(remainMins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
  }
  return `${mins}:${String(secs).padStart(2, "0")}`
}

/**
 * Determine if a topic is operating within healthy parameters.
 * Accounts for static/latched topics (e.g. /tf_static) having 0 expected Hz.
 */
export function isTopicHealthy(topic: TopicStat): boolean {
  // Static latched topics with 0 expected Hz are completely normal in ROS2
  if (topic.name.includes("static") || (topic.expectedHz === 0 && topic.hz === 0)) {
    return true
  }

  // Active topic that died / silent node
  if (topic.hz === 0 && topic.expectedHz > 0) {
    return false
  }

  // Significant message drop rate (>= 40%)
  const dropPct = (topic.dropRate ?? 0) * 100
  if (dropPct >= 40) {
    return false
  }

  return true
}

/**
 * Compute generic, dynamic system-wide metrics for any Rosbag dataset.
 */
export function computeSystemMetrics(params: {
  rosbag: Rosbag | null
  topics?: TopicStat[]
  anomalies?: Anomaly[]
  logs?: LogEvent[]
  health?: HealthSummary | null
}): SystemMetrics {
  const { rosbag, topics: rawTopics = [], anomalies = [] } = params

  const topics = rawTopics.length > 0 ? rawTopics : (rosbag?.topics ?? [])
  const durationSec = rosbag?.durationSec && rosbag.durationSec > 0 ? rosbag.durationSec : 1

  // 1. Messages & Rate calculation
  const totalMessages =
    rosbag?.messageCount && rosbag.messageCount > 0
      ? rosbag.messageCount
      : topics.reduce((sum, t) => sum + (t.messageCount ?? 0), 0)

  const avgRateHz = durationSec > 0 ? totalMessages / durationSec : 0
  const formattedAvgRateHz = avgRateHz >= 100 ? avgRateHz.toFixed(1) : avgRateHz.toFixed(2)
  const rateSubtext = "Tốc độ tin nhắn toàn mạng"

  // 2. Data Volume & Bandwidth Throughput
  let totalSizeBytes = rosbag?.sizeBytes ?? 0
  if (totalSizeBytes <= 0) {
    // Estimate if sizeBytes not provided directly (avg ~100 bytes per ROS msg)
    totalSizeBytes = totalMessages * 100
  }
  const formattedTotalSize = formatBytes(totalSizeBytes)
  const { value: sizeValue, unit: sizeUnit } = splitFormattedBytes(totalSizeBytes)

  const avgBandwidthBps = durationSec > 0 ? totalSizeBytes / durationSec : 0
  const formattedBandwidth = `${formatBytes(avgBandwidthBps)}/s`
  const { value: bandwidthValue, unit: bandwidthUnit } = splitFormattedBytes(avgBandwidthBps)
  const bandwidthSubtext = `~${bandwidthValue} ${bandwidthUnit}/s băng thông TB`

  // 3. Sensor Availability & Topic Status
  const totalTopics = topics.length
  let healthyTopicsCount = 0
  let silentTopicsCount = 0

  for (const t of topics) {
    if (isTopicHealthy(t)) {
      healthyTopicsCount++
    } else {
      if (t.hz === 0 && t.expectedHz > 0) {
        silentTopicsCount++
      }
    }
  }

  const problematicTopicsCount = Math.max(0, totalTopics - healthyTopicsCount)
  const sensorAvailabilityPct =
    totalTopics > 0 ? Math.round((healthyTopicsCount / totalTopics) * 1000) / 10 : 100

  let availabilityStatus: "healthy" | "degraded" | "critical" = "healthy"
  if (sensorAvailabilityPct < 50 || silentTopicsCount > 0) {
    availabilityStatus = "critical"
  } else if (sensorAvailabilityPct < 85) {
    availabilityStatus = "degraded"
  }

  let availabilitySubtext = `${healthyTopicsCount}/${totalTopics} Topic đạt chuẩn`
  if (silentTopicsCount > 0) {
    availabilitySubtext = `${problematicTopicsCount} lỗi • ${silentTopicsCount} Silent node`
  } else if (problematicTopicsCount > 0) {
    availabilitySubtext = `${problematicTopicsCount} Topic sụt giảm tần số`
  }

  // 4. Duration & Messages
  const actualDuration = Math.round(rosbag?.durationSec ?? 0)
  const formattedDuration = formatDuration(actualDuration)
  const durationSubtext = `${actualDuration}s tổng cộng`
  const formattedMessages = totalMessages.toLocaleString()
  const messagesSubtext = `Trên ${totalTopics} topics giám sát`

  // 5. Anomaly breakdown
  let criticalCount = 0
  let highCount = 0
  let mediumCount = 0
  let lowCount = 0

  for (const a of anomalies) {
    if (a.severity === "critical") criticalCount++
    else if (a.severity === "high") highCount++
    else if (a.severity === "medium") mediumCount++
    else lowCount++
  }

  return {
    avgRateHz,
    formattedAvgRateHz,
    rateSubtext,
    totalSizeBytes,
    formattedTotalSize,
    sizeValue,
    sizeUnit,
    avgBandwidthBps,
    formattedBandwidth,
    bandwidthValue,
    bandwidthUnit,
    bandwidthSubtext,
    totalTopics,
    healthyTopicsCount,
    problematicTopicsCount,
    silentTopicsCount,
    sensorAvailabilityPct,
    availabilityStatus,
    availabilitySubtext,
    durationSec,
    formattedDuration,
    durationSubtext,
    totalMessages,
    formattedMessages,
    messagesSubtext,
    totalDetections: anomalies.length,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  }
}
