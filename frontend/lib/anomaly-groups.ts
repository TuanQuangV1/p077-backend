import type { AnomalyKind } from "./types"

/**
 * Which anomaly kinds each health panel is about.
 *
 * The panels used to test for kinds by hand, and every one of those tests named
 * a kind from the demo data generator (`tf_timeout`, `cpu_spike`, `message_drop`
 * …) rather than a kind the backend emits. Real runs therefore rendered as
 * empty — an operator saw a healthy-looking dashboard while the backend was
 * reporting hundreds of anomalies. Both vocabularies are listed here so demo
 * data keeps working, and every group is derived from this one table.
 */
const GROUPS = {
  /** Transform tree: broadcast gaps, frame jumps, conflicting publishers. */
  transform: [
    "tf_missing_gap",
    "tf_drift_jump",
    "tf_conflict",
    "tf_timeout",
    "localization_jump",
  ],
  /** Publish cadence: gaps, drop bursts, rate drops, topics going silent. */
  throughput: [
    "frequency_gap",
    "message_drop_burst",
    "silent_node",
    "hz_drop",
    "hz_drop_critical",
    "message_drop",
    "topic_hz_drop",
    "lidar_dropout",
  ],
  /** Header timestamps: latency, jitter, clock drift. */
  timing: ["header_latency", "timestamp_jitter", "clock_drift"],
  /** Sensor payload contents: NaN, out-of-range, empty. */
  payload: ["payload_nan", "payload_out_of_range", "payload_zero_byte"],
  /** Node log severity. */
  logs: [
    "log_fatal",
    "log_error_burst",
    "log_warn_storm",
    "cpu_spike",
    "nav_recovery",
  ],
} as const satisfies Record<string, readonly AnomalyKind[]>

export type AnomalyGroup = keyof typeof GROUPS

const GROUP_NAMES = Object.keys(GROUPS) as AnomalyGroup[]

const GROUP_SETS = GROUP_NAMES.reduce(
  (acc, group) => {
    acc[group] = new Set<string>(GROUPS[group])
    return acc
  },
  {} as Record<AnomalyGroup, ReadonlySet<string>>,
)

/** True when `kind` belongs to `group`. */
export function isKindIn(group: AnomalyGroup, kind: string): boolean {
  return GROUP_SETS[group].has(kind)
}

/** Keep only the anomalies belonging to `group`. */
export function filterByGroup<T extends { kind: string }>(
  group: AnomalyGroup,
  anomalies: readonly T[],
): T[] {
  return anomalies.filter((a) => isKindIn(group, a.kind))
}

/** Anomalies whose kind belongs to no group, so a new backend kind is visible rather than silently dropped. */
export function ungrouped<T extends { kind: string }>(anomalies: readonly T[]): T[] {
  return anomalies.filter((a) => GROUP_NAMES.every((group) => !isKindIn(group, a.kind)))
}

/**
 * Anomaly start/end in seconds from the start of the recording.
 *
 * `tSec` is absolute simulation time — a fault at t=1815 in a 182-second bag —
 * so plotting it directly against recording duration drew the band off the end
 * of the timeline. The backend now supplies relative time; mock data that
 * predates it falls back to the absolute values, which for mocks start at zero.
 */
export function relativeSpan(a: {
  tSec: number
  endSec: number
  tRelSec?: number
  endRelSec?: number
}): { start: number; end: number } {
  return {
    start: a.tRelSec ?? a.tSec,
    end: a.endRelSec ?? a.endSec,
  }
}
