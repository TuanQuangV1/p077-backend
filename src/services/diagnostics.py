"""Rule-based rosbag diagnostics over a normalized message stream.

Parses rosbag2 SQLite bags (``.db3``) and small JSONL fixtures, then detects
timing anomalies (frequency gaps, drop bursts, timestamp jitter, silent nodes
and clock drift) against configurable thresholds. The analysis consumes a
lazy message iterator so large bags are never materialized in memory. Output
is a compact JSON summary consumed by the API layer.
"""

from __future__ import annotations

import json
import logging
import statistics
from collections import defaultdict
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

import numpy as np

from src.services.bag_stream import iter_rosbag2_messages
from src.services.diagnostics_config import merge_diagnostics_thresholds

logger = logging.getLogger(__name__)

_MIN_NUMPY_MESSAGES = 1000

# A topic breaching a rule more often than this is systematically broken rather
# than suffering discrete incidents; report the worst episodes and stop there.
_MAX_EPISODES_PER_RULE = 10

_MESSAGE_DTYPE = [
    ("timestamp", "f8"),
    ("topic", "U64"),
    ("node", "U64"),
    ("message_type", "U128"),
    ("dt_sec", "f8"),
]

# Non-timing rules added for the Rosbag Health Check framework.
_HZ_WINDOW_SEC = 5.0
_HEADER_LATENCY_MIN_SUSTAINED = 3
_TF_TOPICS = {"/tf", "/tf_static"}
_EVENT_DRIVEN_MESSAGE_TYPES = {
    "diagnostic_msgs/msg/DiagnosticArray",
    "geometry_msgs/msg/PoseWithCovarianceStamped",
}


def parse_rosbag2_db3(path: str | Path) -> list[dict[str, Any]]:
    """Read a rosbag2 SQLite bag (`*.db3`) into a standard message stream.

    Streams the `topics`/`messages` tables through
    :func:`src.services.bag_stream.iter_rosbag2_messages` (message payloads are
    never decoded) and materializes the result, which is enough for
    timing-based diagnostics. Timestamps are converted from nanoseconds to
    seconds and rows are ordered by timestamp.

    Args:
        path: Path to the `.db3` rosbag2 database.

    Returns:
        List of message dicts (`timestamp` in seconds, `topic`, `node`,
        `message_type`).

    Raises:
        sqlite3.DatabaseError: The file is not a readable rosbag2 database.
    """
    return list(iter_rosbag2_messages(path))


def parse_mcap_file(path: str | Path) -> list[dict[str, Any]]:
    """Read a small `.mcap`-style JSONL fixture into a standard message stream.

    This keeps the route compatible with a real file-backed workflow while the
    production bag reader dependency is still being introduced.

    Each non-empty line of the file is expected to be a single JSON object
    describing one ROS message (e.g. `timestamp`, `topic`, `node`, `message_type`).

    Args:
        path: Path to the JSONL fixture file to read.

    Returns:
        List of message dicts, one per non-empty JSON line in file order.

    Raises:
        FileNotFoundError: The given path does not exist.
        json.JSONDecodeError: A line contains malformed JSON.
    """
    file_path = Path(path)
    messages: list[dict[str, Any]] = []
    with file_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue

            messages.append(json.loads(line))

    return messages


def denormalize_message_stream(
    messages: list[dict[str, Any]],
) -> np.ndarray | list[dict[str, Any]]:
    """Convert a ROS topic stream into normalized rows for analysis.

    Small streams (fewer than ``_MIN_NUMPY_MESSAGES`` messages) are returned as
    plain dict rows to avoid paying NumPy overhead on tiny inputs; larger
    streams get a compact structured array for vectorized downstream analysis.
    The large-stream path preallocates the array up front instead of building
    intermediate dict rows, avoiding per-message allocation and a second pass.

    Each message must contain `timestamp` (float), `topic`, `node` and
    `message_type` keys. `dt_sec` is computed as the delta to the previous
    message timestamp (0 for the first message).

    Args:
        messages: List of message dicts from a parsed ROS stream.

    Returns:
        For small inputs, a list of dicts with keys `timestamp`, `topic`,
        `node`, `message_type`, `dt_sec`. For inputs with at least
        ``_MIN_NUMPY_MESSAGES`` messages, a structured NumPy array with the
        same fields.
    """
    count = len(messages)
    if count >= _MIN_NUMPY_MESSAGES:
        arr = np.empty(count, dtype=_MESSAGE_DTYPE)
        previous_timestamp: float | None = None
        for i, message in enumerate(messages):
            timestamp = float(message["timestamp"])
            arr[i] = (
                timestamp,
                str(message["topic"]),
                str(message["node"]),
                str(message["message_type"]),
                0.0 if previous_timestamp is None else timestamp - previous_timestamp,
            )
            previous_timestamp = timestamp
        return arr

    rows: list[dict[str, Any]] = []
    previous_timestamp = None
    for message in messages:
        timestamp = float(message["timestamp"])
        topic = str(message["topic"])
        node = str(message["node"])
        message_type = str(message["message_type"])
        dt_sec = 0.0 if previous_timestamp is None else timestamp - previous_timestamp
        rows.append(
            {
                "timestamp": timestamp,
                "topic": topic,
                "node": node,
                "message_type": message_type,
                "dt_sec": dt_sec,
            }
        )
        previous_timestamp = timestamp
    return rows


def _gap_stats(timestamps: list[float]) -> tuple[float, float, int]:
    """Return (median interval, max interval, index of the max interval)."""
    if len(timestamps) >= _MIN_NUMPY_MESSAGES:
        all_intervals = np.diff(np.asarray(timestamps, dtype=float))
        positive = all_intervals[all_intervals > 0]
        return (
            float(np.median(positive)) if positive.size else 0.0,
            float(np.max(all_intervals)),
            int(np.argmax(all_intervals)),
        )
    diffs = [b - a for a, b in pairwise(timestamps)]
    positive = [interval for interval in diffs if interval > 0]
    max_interval = max(diffs)
    median_interval = float(statistics.median(positive)) if positive else 0.0
    return median_interval, max_interval, diffs.index(max_interval)


def _threshold_episodes(
    spans: list[tuple[float, float, float]],
    threshold: float,
) -> list[tuple[float, float, float, int]]:
    """Merge consecutive over-threshold spans into episodes.

    ``spans`` are ``(start_sec, end_sec, duration_sec)`` in time order. Adjacent
    breaches belong to one incident, so a sustained rate drop is reported once
    across its real duration instead of once per message, while breaches
    separated by healthy traffic stay separate incidents.

    Returns ``(start_sec, end_sec, worst_duration_sec, breach_count)`` per
    episode, in time order, keeping only the ``_MAX_EPISODES_PER_RULE`` worst
    when a topic breaches more often than that.
    """
    episodes: list[tuple[float, float, float, int]] = []
    start: float | None = None
    end = worst = 0.0
    count = 0
    for span_start, span_end, duration in spans:
        if duration > threshold:
            if start is None:
                start, worst, count = span_start, duration, 0
            worst = max(worst, duration)
            end = span_end
            count += 1
        elif start is not None:
            episodes.append((start, end, worst, count))
            start = None
    if start is not None:
        episodes.append((start, end, worst, count))
    if len(episodes) > _MAX_EPISODES_PER_RULE:
        worst_first = sorted(episodes, key=lambda episode: episode[2], reverse=True)
        episodes = sorted(worst_first[:_MAX_EPISODES_PER_RULE])
    return episodes


def _timestamp_jitter(timestamps: list[float]) -> float:
    """Population std-dev of consecutive inter-message intervals (seconds)."""
    if len(timestamps) < 3:
        return 0.0
    if len(timestamps) >= _MIN_NUMPY_MESSAGES:
        intervals = np.diff(np.asarray(timestamps, dtype=float))
        return float(np.std(intervals))
    intervals = [b - a for a, b in pairwise(timestamps)]
    return float(statistics.pstdev(intervals)) if len(intervals) >= 2 else 0.0


def _median_abs(values: list[float]) -> float:
    """Median of the absolute values, vectorized for large inputs."""
    if len(values) >= _MIN_NUMPY_MESSAGES:
        return float(np.median(np.abs(np.asarray(values, dtype=float))))
    return float(statistics.median(abs(value) for value in values))


def _evaluate_topic_rules(
    topic: str,
    timestamps_arr: list[float],
    thresholds: dict[str, float],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Evaluate frequency-gap, drop-burst and jitter rules for one topic."""
    median_interval, max_interval, _ = _gap_stats(timestamps_arr)
    spans = [(float(a), float(b), float(b - a)) for a, b in pairwise(timestamps_arr)]
    detections: list[dict[str, Any]] = []
    logs: list[dict[str, Any]] = []

    minimum_threshold = thresholds["frequency_gap_min_threshold_sec"]
    multiplier = thresholds["frequency_gap_multiplier"]
    threshold = max(minimum_threshold, median_interval * multiplier)
    gap_log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "frequency_gap",
        "level": "debug",
        "message": "Evaluated frequency gap rule.",
        "details": {
            "topic": topic,
            "message_count": len(timestamps_arr),
            "median_interval_sec": round(median_interval, 4),
            "max_interval_sec": round(max_interval, 4),
            "threshold_sec": round(threshold, 4),
            "thresholds": {
                "frequency_gap_min_threshold_sec": minimum_threshold,
                "frequency_gap_multiplier": multiplier,
            },
        },
    }
    gap_episodes = _threshold_episodes(spans, threshold)
    for start_sec, end_sec, worst, breaches in gap_episodes:
        detections.append(
            {
                "kind": "frequency_gap",
                "topic": topic,
                "severity": "medium",
                "confidence": 0.81,
                "tSec": start_sec,
                "endSec": end_sec,
                "evidence": {
                    "interval_sec": round(worst, 4),
                    "threshold_sec": round(threshold, 4),
                    "occurrence_count": breaches,
                },
            }
        )
    gap_log_payload["details"]["detected"] = bool(gap_episodes)
    gap_log_payload["details"]["episode_count"] = len(gap_episodes)
    if gap_episodes:
        gap_log_payload["level"] = "warn"
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": gap_log_payload})
    else:
        logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": gap_log_payload})
    logs.append(gap_log_payload)

    burst_threshold = thresholds["max_gap_burst_sec"]
    burst_log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "message_drop_burst",
        "level": "debug",
        "message": "Evaluated message drop burst rule.",
        "details": {
            "topic": topic,
            "message_count": len(timestamps_arr),
            "max_interval_sec": round(max_interval, 4),
            "threshold_sec": round(burst_threshold, 4),
        },
    }
    burst_episodes = _threshold_episodes(spans, burst_threshold)
    for start_sec, end_sec, worst, breaches in burst_episodes:
        detections.append(
            {
                "kind": "message_drop_burst",
                "topic": topic,
                "severity": "medium",
                "confidence": 0.8,
                "tSec": start_sec,
                "endSec": end_sec,
                "evidence": {
                    "max_gap_sec": round(worst, 4),
                    "threshold_sec": round(burst_threshold, 4),
                    "occurrence_count": breaches,
                },
            }
        )
    burst_log_payload["details"]["detected"] = bool(burst_episodes)
    burst_log_payload["details"]["episode_count"] = len(burst_episodes)
    if burst_episodes:
        burst_log_payload["level"] = "warn"
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": burst_log_payload})
    else:
        logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": burst_log_payload})
    logs.append(burst_log_payload)

    jitter_threshold = thresholds["timestamp_jitter_max_sec"]
    jitter = _timestamp_jitter(timestamps_arr)
    jitter_log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "timestamp_jitter",
        "level": "debug",
        "message": "Evaluated timestamp jitter rule.",
        "details": {
            "topic": topic,
            "message_count": len(timestamps_arr),
            "jitter_sec": round(jitter, 4),
            "threshold_sec": round(jitter_threshold, 4),
        },
    }
    if jitter > jitter_threshold:
        detections.append(
            {
                "kind": "timestamp_jitter",
                "topic": topic,
                "severity": "low",
                "confidence": 0.7,
                "tSec": float(timestamps_arr[0]),
                "endSec": float(timestamps_arr[-1]),
                "evidence": {
                    "jitter_sec": round(jitter, 4),
                    "threshold_sec": round(jitter_threshold, 4),
                },
            }
        )
        jitter_log_payload["level"] = "warn"
        jitter_log_payload["details"]["detected"] = True
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": jitter_log_payload})
    else:
        jitter_log_payload["details"]["detected"] = False
        logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": jitter_log_payload})
    logs.append(jitter_log_payload)

    return detections, logs


def _evaluate_drift_rule(
    topic: str,
    drifts: list[float],
    timestamps_arr: list[float],
    thresholds: dict[str, float],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Evaluate the clock-drift rule for one topic (bag vs header timestamp)."""
    drift = _median_abs(drifts)
    drift_threshold = thresholds["clock_drift_max_sec"]
    drift_log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "clock_drift",
        "level": "debug",
        "message": "Evaluated clock drift rule.",
        "details": {
            "topic": topic,
            "message_count": len(drifts),
            "drift_sec": round(drift, 4),
            "threshold_sec": round(drift_threshold, 4),
        },
    }
    if drift > drift_threshold:
        drift_log_payload["level"] = "warn"
        drift_log_payload["details"]["detected"] = True
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": drift_log_payload})
        return (
            {
                "kind": "clock_drift",
                "topic": topic,
                "severity": "medium",
                "confidence": 0.85,
                "tSec": float(timestamps_arr[0]),
                "endSec": float(timestamps_arr[-1]),
                "evidence": {
                    "drift_sec": round(drift, 4),
                    "threshold_sec": round(drift_threshold, 4),
                },
            },
            drift_log_payload,
        )
    drift_log_payload["details"]["detected"] = False
    logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": drift_log_payload})
    return None, drift_log_payload


def _evaluate_silent_rule(
    topic: str,
    node: str,
    timestamps_arr: list[float],
    observation_end: float,
    thresholds: dict[str, float],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Flag every sustained silent gap in a topic's publish stream.

    A node's *active* span is not evidence of silence.  Instead, compare each
    inter-message gap (plus a possible trailing gap to the observation end)
    with both an absolute floor and the topic's normal median cadence. A topic
    that falls silent repeatedly yields one detection per outage.
    """
    intervals = [(float(a), float(b), float(b - a)) for a, b in pairwise(timestamps_arr)]
    if observation_end > timestamps_arr[-1]:
        intervals.append(
            (
                float(timestamps_arr[-1]),
                float(observation_end),
                float(observation_end - timestamps_arr[-1]),
            )
        )
    median_interval = float(statistics.median(b - a for a, b in pairwise(timestamps_arr)))
    minimum_threshold = float(thresholds["silent_node_min_span_sec"])
    multiplier = float(thresholds["silent_node_gap_multiplier"])
    resolved_gap_threshold = max(minimum_threshold, median_interval * multiplier)
    max_gap = max(duration for _, _, duration in intervals)
    node_log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "silent_node",
        "level": "debug",
        "message": "Evaluated silent node rule.",
        "details": {
            "node": node,
            "topic": topic,
            "message_count": len(timestamps_arr),
            "median_interval_sec": round(median_interval, 4),
            "max_silent_gap_sec": round(max_gap, 4),
            "threshold_sec": round(resolved_gap_threshold, 4),
        },
    }
    episodes = _threshold_episodes(intervals, resolved_gap_threshold)
    detections = [
        {
            "kind": "silent_node",
            "topic": topic,
            "severity": "critical",
            "confidence": 0.92,
            "tSec": start_sec,
            "endSec": end_sec,
            "evidence": {
                "node": node,
                "last_timestamp_sec": start_sec,
                "resume_timestamp_sec": end_sec,
                "silent_duration_sec": round(worst, 4),
                "threshold_sec": round(resolved_gap_threshold, 4),
                "median_interval_sec": round(median_interval, 4),
                "occurrence_count": breaches,
            },
        }
        for start_sec, end_sec, worst, breaches in episodes
    ]
    node_log_payload["details"]["detected"] = bool(episodes)
    node_log_payload["details"]["episode_count"] = len(episodes)
    if episodes:
        node_log_payload["level"] = "warn"
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": node_log_payload})
    else:
        logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": node_log_payload})
    return detections, node_log_payload


def _window_hz(
    timestamps: list[float],
    window_sec: float = _HZ_WINDOW_SEC,
) -> list[tuple[float, float]]:
    """Return ``(window_start, hz)`` pairs from a sorted timestamp series.

    Messages are bucketed into fixed windows; the effective rate of a bucket is
    ``count / occupied_span`` (``count / window_sec`` for single-message
    buckets) so partial windows do not inflate the rate.
    """
    if not timestamps:
        return []
    windows: dict[int, list[float]] = defaultdict(list)
    for ts in timestamps:
        windows[int(ts // window_sec)].append(ts)

    result: list[tuple[float, float]] = []
    for key in sorted(windows):
        stamps = windows[key]
        count = len(stamps)
        span = max(stamps[-1] - stamps[0], 1e-6)
        hz = (count - 1) / span if count > 1 else count / window_sec
        result.append((float(key) * window_sec, hz))
    return result


def _evaluate_hz_drop_rules(
    topic: str,
    timestamps_arr: list[float],
    thresholds: dict[str, float],
    expected_hz: Mapping[str, float] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Flag sustained publish-rate drops relative to an expected Hz.

    Two severity tiers follow the framework spec: a window whose effective rate
    is more than ``hz_drop_warn_pct`` (30%) below expected emits ``hz_drop``;
    more than ``hz_drop_critical_pct`` (50%) emits ``hz_drop_critical``. Topics
    with fewer than ``hz_drop_min_messages`` messages are skipped to avoid
    flagging naturally sparse streams.
    """
    detections: list[dict[str, Any]] = []
    logs: list[dict[str, Any]] = []

    if len(timestamps_arr) < int(thresholds["hz_drop_min_messages"]):
        return detections, logs

    has_explicit_expected = expected_hz is not None and topic in expected_hz
    resolved_expected: float | None = None
    if has_explicit_expected:
        resolved_expected = float(expected_hz[topic])

    windows = _window_hz(timestamps_arr)
    if resolved_expected is None:
        intervals = [b - a for a, b in pairwise(timestamps_arr) if b > a]
        if not intervals:
            return detections, logs
        median_interval = float(statistics.median(intervals))
        # Without an explicit baseline, highly bursty/event-driven topics do
        # not have a meaningful nominal Hz.  Skip rate-drop scoring for those
        # streams instead of treating their fastest burst as the baseline.
        if max(intervals) > median_interval * 5.0:
            return detections, logs
        resolved_expected = 1.0 / median_interval

    warn_pct = float(thresholds["hz_drop_warn_pct"])
    critical_pct = float(thresholds["hz_drop_critical_pct"])
    log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "hz_drop",
        "level": "debug",
        "message": "Evaluated publish-rate drop rule.",
        "details": {
            "topic": topic,
            "expected_hz": round(resolved_expected, 4),
            "message_count": len(timestamps_arr),
            "windows": len(windows),
        },
    }
    candidates: list[tuple[float, float, float, str, str, float]] = []
    for start, actual in windows:
        if actual <= 0:
            continue
        drop_pct = 1.0 - actual / resolved_expected
        if drop_pct < warn_pct:
            continue
        kind = "hz_drop_critical" if drop_pct >= critical_pct else "hz_drop"
        severity = "high" if kind == "hz_drop_critical" else "medium"
        candidates.append((start, actual, drop_pct, kind, severity, 0.9 if kind == "hz_drop_critical" else 0.83))

    # A sustained drop should be one anomaly band, not one UI item per 5-second
    # bucket.  Merge adjacent windows of the same severity/kind.
    segments: list[list[tuple[float, float, float, str, str, float]]] = []
    for candidate in candidates:
        if (
            segments
            and segments[-1][-1][3] == candidate[3]
            and candidate[0] <= segments[-1][-1][0] + _HZ_WINDOW_SEC + 1e-9
        ):
            segments[-1].append(candidate)
        else:
            segments.append([candidate])
    for segment in segments:
        start = segment[0][0]
        end = segment[-1][0] + _HZ_WINDOW_SEC
        actual = min(item[1] for item in segment)
        drop_pct = max(item[2] for item in segment)
        kind, severity, confidence = segment[0][3:]
        detections.append(
            {
                "kind": kind,
                "topic": topic,
                "severity": severity,
                "confidence": confidence,
                "tSec": float(start),
                "endSec": float(end),
                "evidence": {
                    "expected_hz": round(resolved_expected, 4),
                    "actual_hz": round(actual, 4),
                    "drop_pct": round(drop_pct, 4),
                    "window_sec": _HZ_WINDOW_SEC,
                    "window_count": len(segment),
                },
            }
        )
    fired = bool(detections)
    log_payload["level"] = "warn" if fired else "debug"
    log_payload["details"]["detected"] = fired
    logs.append(log_payload)
    return detections, logs


def _evaluate_header_latency_rule(
    topic: str,
    latencies: list[tuple[float, float]],
    thresholds: dict[str, float],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Flag sustained publish/header timestamp skew above 100 ms.

    ``latencies`` holds ``(bag_timestamp, publish_lag_sec)`` pairs. The rule
    fires when at least ``_HEADER_LATENCY_MIN_SUSTAINED`` messages lag more than
    ``header_latency_max_ms`` behind their header stamp.
    """
    threshold_sec = float(thresholds["header_latency_max_ms"]) / 1000.0
    over = [(ts, lag) for ts, lag in latencies if lag > threshold_sec]
    log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "header_latency",
        "level": "debug",
        "message": "Evaluated header latency rule.",
        "details": {
            "topic": topic,
            "over_threshold_count": len(over),
            "sustained_min": _HEADER_LATENCY_MIN_SUSTAINED,
            "threshold_sec": threshold_sec,
        },
    }
    if len(over) < _HEADER_LATENCY_MIN_SUSTAINED:
        log_payload["details"]["detected"] = False
        return None, log_payload

    max_lag = max(lag for _, lag in over)
    log_payload["level"] = "warn"
    log_payload["details"]["detected"] = True
    return (
        {
            "kind": "header_latency",
            "topic": topic,
            "severity": "medium",
            "confidence": 0.84,
            "tSec": float(over[0][0]),
            "endSec": float(over[-1][0]),
            "evidence": {
                "max_latency_ms": round(max_lag * 1000.0, 2),
                "threshold_ms": round(threshold_sec * 1000.0, 2),
                "count": len(over),
            },
        },
        log_payload,
    )


def _evaluate_log_severity_rules(
    topic: str,
    entries: list[tuple[float, str]],
    thresholds: dict[str, float],
) -> list[dict[str, Any]]:
    """Flag ERROR / FATAL bursts and sustained WARN storms from /rosout-style logs.

    ``entries`` holds ``(timestamp, level)`` pairs where ``level`` is one of
    ``debug|info|warn|error|fatal``. Fires three kinds:

    - ``log_fatal``: at least ``log_fatal_min_count`` fatal entries (critical).
    - ``log_error_burst``: at least ``log_error_min_count`` error entries (high).
    - ``log_warn_storm``: at least ``log_warn_min_count`` warn entries (low).
    """
    detections: list[dict[str, Any]] = []
    spec = (
        ("fatal", "log_fatal", "critical", 0.95, int(thresholds["log_fatal_min_count"])),
        ("error", "log_error_burst", "high", 0.9, int(thresholds["log_error_min_count"])),
        ("warn", "log_warn_storm", "low", 0.75, int(thresholds["log_warn_min_count"])),
    )
    for label, kind, severity, confidence, min_count in spec:
        matching = [ts for ts, level in entries if level == label]
        if len(matching) < min_count:
            continue
        detections.append(
            {
                "kind": kind,
                "topic": topic,
                "severity": severity,
                "confidence": confidence,
                "tSec": float(min(matching)),
                "endSec": float(max(matching)),
                "evidence": {
                    "level": label,
                    "count": len(matching),
                    "min_count": min_count,
                },
            }
        )
    return detections


def _evaluate_payload_rules(
    topic: str,
    payloads: list[tuple[float, int]],
    thresholds: dict[str, float],
) -> list[dict[str, Any]]:
    """Flag sensor payloads collapsing to zero bytes.

    ``payloads`` holds ``(timestamp, payload_bytes)`` pairs. Fires
    ``payload_zero_byte`` when at least ``payload_zero_byte_min_count`` messages
    carry an empty payload (a classic dead-stream / null-pointcloud signal).
    """
    zeros = [(ts, size) for ts, size in payloads if int(size) == 0]
    min_count = int(thresholds["payload_zero_byte_min_count"])
    if len(zeros) < min_count:
        return []
    return [
        {
            "kind": "payload_zero_byte",
            "topic": topic,
            "severity": "high",
            "confidence": 0.88,
            "tSec": float(zeros[0][0]),
            "endSec": float(zeros[-1][0]),
            "evidence": {
                "zero_byte_count": len(zeros),
                "min_count": min_count,
            },
        }
    ]


def _evaluate_tf_rules(
    topic: str,
    pairs: list[tuple[float, str, str]],
    thresholds: dict[str, float],
    observation_end: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Validate TF broadcast integrity for a ``/tf`` / ``/tf_static`` topic.

    Two signals, both evaluated **per edge** (grouped by ``child_frame_id``)
    rather than on the topic's aggregate timestamp stream: a healthy edge
    (e.g. a wheel joint) publishing throughout a bag would otherwise mask a
    different edge (e.g. ``odom -> base_footprint``) going silent, which is
    exactly the failure mode a stalled localization broadcaster produces.

    - ``tf_missing_gap``: a broadcast gap on one edge longer than
      ``tf_max_missing_span_sec`` (a stalled broadcaster breaks localization
      downstream). Every sustained gap is reported (via
      :func:`_threshold_episodes`), not just the worst one. Only ``/tf`` gets
      a trailing gap to ``observation_end``: ``/tf_static`` is latched and
      legitimately published once, so treating "never republished" as a gap
      there would flag every static transform in every bag.
    - ``tf_drift_jump``: a child frame is re-parented to a different parent
      frame (re-rooting / localization switch), surfaced at critical severity.

    ``pairs`` holds ``(timestamp, frame_id, child_frame_id)`` tuples — one per
    broadcast edge observed on the topic (a single ``/tf`` message can batch
    several edges), not necessarily time-ordered.
    """
    detections: list[dict[str, Any]] = []
    logs: list[dict[str, Any]] = []

    missing_threshold = float(thresholds["tf_max_missing_span_sec"])
    by_child: dict[str, list[tuple[float, str]]] = defaultdict(list)
    for ts, frame, child in pairs:
        if child:
            by_child[child].append((ts, frame))

    gap_log: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "tf_missing_gap",
        "level": "debug",
        "message": "Evaluated TF missing-transform gap rule.",
        "details": {"topic": topic, "threshold_sec": missing_threshold, "edge_count": len(by_child)},
    }
    episode_count = 0
    for child, entries in by_child.items():
        entries.sort(key=lambda entry: entry[0])
        timestamps = [ts for ts, _ in entries]
        parent = entries[-1][1]
        spans = [(a, b, b - a) for a, b in pairwise(timestamps)]
        if topic == "/tf" and observation_end > timestamps[-1]:
            spans.append((timestamps[-1], observation_end, observation_end - timestamps[-1]))
        for start_sec, end_sec, worst, occurrence in _threshold_episodes(spans, missing_threshold):
            episode_count += 1
            detections.append(
                {
                    "kind": "tf_missing_gap",
                    "topic": topic,
                    "severity": "high",
                    "confidence": 0.86,
                    "tSec": start_sec,
                    "endSec": end_sec,
                    "evidence": {
                        "child_frame": child,
                        "parent_frame": parent,
                        "gap_sec": round(worst, 4),
                        "threshold_sec": round(missing_threshold, 4),
                        "occurrence_count": occurrence,
                    },
                }
            )
    gap_log["details"]["detected"] = episode_count > 0
    gap_log["details"]["episode_count"] = episode_count
    if episode_count:
        gap_log["level"] = "warn"
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": gap_log})
    else:
        logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": gap_log})
    logs.append(gap_log)

    parent_of: dict[str, tuple[str, float]] = {}
    jump_log: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "tf_drift_jump",
        "level": "debug",
        "message": "Evaluated TF drift/jump re-parenting rule.",
        "details": {"topic": topic},
    }
    for ts, frame, child in sorted(pairs, key=lambda pair: pair[0]):
        if not child:
            continue
        previous = parent_of.get(child)
        if previous is not None and previous[0] != frame:
            jump_log["level"] = "warn"
            jump_log["details"]["detected"] = True
            detections.append(
                {
                    "kind": "tf_drift_jump",
                    "topic": topic,
                    "severity": "critical",
                    "confidence": 0.9,
                    "tSec": float(previous[1]),
                    "endSec": float(ts),
                    "evidence": {
                        "child_frame": child,
                        "from_frame": previous[0],
                        "to_frame": frame,
                    },
                }
            )
            break
        parent_of[child] = (frame, ts)
    jump_log["details"].setdefault("detected", False)
    logs.append(jump_log)

    return detections, logs


def _evaluate_data_quality_rule(
    topic: str,
    samples: list[tuple[float, float]],
    thresholds: dict[str, float],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Flag sustained NaN corruption in payload arrays such as LaserScan ranges.

    ``samples`` holds ``(timestamp, nan_ratio)`` pairs, time-ordered — the
    fraction of one message's array (e.g. ``ranges``) that decoded as NaN. A
    message counts as corrupted once its ratio exceeds
    ``payload_nan_ratio_min``; a corrupted stretch of at least
    ``payload_nan_min_count`` consecutive messages is one incident, reported
    by its real duration (e.g. a failing photodiode segment lasting minutes)
    instead of once per message.
    """
    ratio_threshold = float(thresholds["payload_nan_ratio_min"])
    min_count = int(thresholds["payload_nan_min_count"])
    detections: list[dict[str, Any]] = []
    log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "payload_nan",
        "level": "debug",
        "message": "Evaluated payload NaN-ratio rule.",
        "details": {
            "topic": topic,
            "message_count": len(samples),
            "ratio_threshold": ratio_threshold,
            "min_count": min_count,
        },
    }

    episodes: list[tuple[float, float, float, int]] = []
    start: float | None = None
    end = worst = 0.0
    count = 0
    for ts, ratio in samples:
        if ratio > ratio_threshold:
            if start is None:
                start, worst, count = ts, ratio, 0
            worst = max(worst, ratio)
            end = ts
            count += 1
        elif start is not None:
            if count >= min_count:
                episodes.append((start, end, worst, count))
            start = None
    if start is not None and count >= min_count:
        episodes.append((start, end, worst, count))

    for start_sec, end_sec, worst_ratio, occurrence in episodes:
        detections.append(
            {
                "kind": "payload_nan",
                "topic": topic,
                "severity": "critical",
                "confidence": 0.87,
                "tSec": start_sec,
                "endSec": end_sec,
                "evidence": {
                    "max_nan_ratio": round(worst_ratio, 4),
                    "threshold_ratio": ratio_threshold,
                    "occurrence_count": occurrence,
                },
            }
        )
    log_payload["details"]["detected"] = bool(episodes)
    log_payload["details"]["episode_count"] = len(episodes)
    if episodes:
        log_payload["level"] = "warn"
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": log_payload})
    else:
        logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": log_payload})
    return detections, log_payload


def _evaluate_auxiliary_rules(
    topic_times: dict[str, list[float]],
    topic_latency: dict[str, list[tuple[float, float]]],
    log_entries: dict[str, list[tuple[float, str]]],
    topic_payload: dict[str, list[tuple[float, int]]],
    topic_nan: dict[str, list[tuple[float, float]]],
    tf_pairs: dict[str, list[tuple[float, str, str]]],
    thresholds: dict[str, float],
    expected_hz: Mapping[str, float] | None,
    cadence_topics: set[str],
    observation_end: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Run the hz-drop, header-latency, log, payload, data-quality and TF rule batteries.

    Kept separate from :func:`detect_anomalies` so the timing rules stay
    readable and each health indicator group can be reasoned about (and tested)
    in isolation.
    """
    detections: list[dict[str, Any]] = []
    logs: list[dict[str, Any]] = []

    for topic, timestamps in topic_times.items():
        if topic not in cadence_topics:
            continue
        timestamps_arr = sorted(timestamps)
        hz_detections, hz_logs = _evaluate_hz_drop_rules(topic, timestamps_arr, thresholds, expected_hz)
        detections.extend(hz_detections)
        logs.extend(hz_logs)

    for topic, latencies in topic_latency.items():
        if topic.rstrip("/").endswith("cmd_vel"):
            continue
        latency_detection, latency_log = _evaluate_header_latency_rule(topic, latencies, thresholds)
        if latency_detection is not None:
            detections.append(latency_detection)
        logs.append(latency_log)

    for topic, entries in log_entries.items():
        detections.extend(_evaluate_log_severity_rules(topic, sorted(entries), thresholds))

    for topic, payloads in topic_payload.items():
        detections.extend(_evaluate_payload_rules(topic, sorted(payloads), thresholds))

    for topic, samples in topic_nan.items():
        nan_detections, nan_log = _evaluate_data_quality_rule(topic, sorted(samples), thresholds)
        detections.extend(nan_detections)
        logs.append(nan_log)

    for topic, pairs in tf_pairs.items():
        tf_detections, tf_logs = _evaluate_tf_rules(topic, pairs, thresholds, observation_end)
        detections.extend(tf_detections)
        logs.extend(tf_logs)

    return detections, logs


def detect_anomalies(
    messages: Iterable[Mapping[str, Any]],
    thresholds: dict[str, Any] | None = None,
    expected_hz: Mapping[str, float] | None = None,
) -> dict[str, Any]:
    """Emit a compact JSON summary for timing anomalies in a message stream.

    The stream is consumed exactly once, so `messages` may be a lazy iterator
    (e.g. :func:`src.services.bag_stream.iter_bag_messages`) without loading a
    whole bag into memory; only the per-topic / per-node aggregates are kept.

    Rules evaluated per message stream:

    - `frequency_gap`: for each topic with >= 2 messages, a gap is flagged when
      the max inter-message interval exceeds `max(frequency_gap_min_threshold_sec,
      median_interval * frequency_gap_multiplier)`.
    - `message_drop_burst`: a single inter-message interval exceeding the
      absolute ceiling `max_gap_burst_sec` (independent of the median).
    - `timestamp_jitter`: the population std-dev of inter-message intervals of
      a topic exceeding `timestamp_jitter_max_sec`.
    - `silent_node`: for each node with >= 2 messages, a node is flagged when
      its active span (last - first timestamp) reaches `silent_node_min_span_sec`.
    - `clock_drift`: the median |bag timestamp - header timestamp| of a topic
      exceeding `clock_drift_max_sec`. Only evaluated when messages carry a
      `header` field (e.g. produced by the light-decode bag reader).
    - `hz_drop` / `hz_drop_critical`: a time window whose effective publish rate
      falls more than `hz_drop_warn_pct` / `hz_drop_critical_pct` below the
      expected rate (from `expected_hz`, else the peak window rate). Requires at
      least `hz_drop_min_messages` messages.
    - `header_latency`: at least `_HEADER_LATENCY_MIN_SUSTAINED` messages whose
      bag timestamp lags their `header.stamp` by more than `header_latency_max_ms`.
    - `log_fatal` / `log_error_burst` / `log_warn_storm`: counts of fatal/error/
      warn entries on /rosout-style topics crossing `log_*_min_count`.
    - `payload_zero_byte`: at least `payload_zero_byte_min_count` messages whose
      `payload_bytes` field is 0.
    - `payload_nan`: a stretch of at least `payload_nan_min_count` consecutive
      messages whose `nan_ratio` field (fraction of e.g. LaserScan `ranges`
      that decoded as NaN) exceeds `payload_nan_ratio_min`.
    - `tf_missing_gap` / `tf_drift_jump`: per-edge broadcast gaps and frame
      re-parenting on `/tf` / `/tf_static` topics, keyed by `child_frame_id` so
      one silent edge is not masked by other edges still publishing.

    Args:
        messages: Iterable of message dicts. Recognized fields include
            `timestamp`, `topic`, `node`, `message_type`, optional `header`
            (seconds), `frame_id`, `child_frame_id`, `transforms` (list of
            `{frame_id, child_frame_id}` for a batched `/tf` publish), `level`,
            `payload_bytes` and `nan_ratio`.
        thresholds: Optional overrides merged over the persisted defaults via
            `merge_diagnostics_thresholds`. `None` uses the defaults as-is.
        expected_hz: Optional `topic -> expected publish rate` map used to score
            the `hz_drop` rules.

    Returns:
        Dict with keys: `summary` (total_messages, total_detections, severity),
        `detections` (list of detected anomalies with kind/severity/confidence/
        evidence), `thresholds` (the resolved thresholds used) and `logs`
        (per-rule evaluation log entries).
    """
    resolved_thresholds = merge_diagnostics_thresholds(thresholds=thresholds)
    logs: list[dict[str, Any]] = []

    topic_times: dict[str, list[float]] = defaultdict(list)
    topic_message_types: dict[str, set[str]] = defaultdict(set)
    topic_node_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    topic_drift: dict[str, list[float]] = defaultdict(list)
    topic_latency: dict[str, list[tuple[float, float]]] = defaultdict(list)
    topic_payload: dict[str, list[tuple[float, int]]] = defaultdict(list)
    topic_nan: dict[str, list[tuple[float, float]]] = defaultdict(list)
    log_entries: dict[str, list[tuple[float, str]]] = defaultdict(list)
    tf_pairs: dict[str, list[tuple[float, str, str]]] = defaultdict(list)
    total_messages = 0
    for message in messages:
        timestamp = float(message["timestamp"])
        topic = str(message["topic"])
        node = str(message["node"])
        total_messages += 1
        topic_times[topic].append(timestamp)
        topic_message_types[topic].add(str(message.get("message_type") or ""))
        topic_node_counts[topic][node] += 1
        header = message.get("header")
        if header is not None:
            drift = timestamp - float(header)
            topic_drift[topic].append(drift)
            topic_latency[topic].append((timestamp, drift))
        payload_bytes = message.get("payload_bytes")
        if payload_bytes is not None:
            topic_payload[topic].append((timestamp, int(payload_bytes)))
        nan_ratio = message.get("nan_ratio")
        if nan_ratio is not None:
            topic_nan[topic].append((timestamp, float(nan_ratio)))
        level = message.get("level")
        if level is not None:
            log_entries[topic].append((timestamp, str(level).lower()))
        if topic in _TF_TOPICS:
            transforms = message.get("transforms")
            if transforms:
                for transform in transforms:
                    tr_frame = str(transform.get("frame_id") or "")
                    tr_child = str(transform.get("child_frame_id") or "")
                    if tr_frame or tr_child:
                        tf_pairs[topic].append((timestamp, tr_frame, tr_child))
            else:
                frame_id = str(message.get("frame_id") or "")
                child_frame_id = str(message.get("child_frame_id") or "")
                if frame_id or child_frame_id:
                    tf_pairs[topic].append((timestamp, frame_id, child_frame_id))

    if total_messages == 0:
        empty_log_payload: dict[str, Any] = {
            "event": "diagnostics.analysis.empty_input",
            "level": "info",
            "message": "No messages available for diagnostics.",
            "details": {
                "message_count": 0,
                "thresholds": resolved_thresholds,
            },
        }
        logger.info("diagnostics.analysis.empty_input", extra={"diagnostics": empty_log_payload})
        return {
            "summary": {
                "total_messages": 0,
                "total_detections": 0,
                "severity": "low",
            },
            "detections": [],
            "thresholds": resolved_thresholds,
            "logs": [empty_log_payload],
        }

    # Status/event messages have no stable publish cadence unless a caller
    # supplies an explicit expected rate. Treating their natural pauses as
    # failures produced false Gate 2 alarms on healthy captures.
    cadence_topics = {
        topic
        for topic, message_types in topic_message_types.items()
        if (expected_hz is not None and topic in expected_hz)
        or not message_types.intersection(_EVENT_DRIVEN_MESSAGE_TYPES)
    }

    detections: list[dict[str, Any]] = []
    for topic, timestamps in topic_times.items():
        if topic not in cadence_topics:
            continue
        timestamps_arr = sorted(timestamps)
        if len(timestamps_arr) < 2:
            continue
        topic_detections, topic_logs = _evaluate_topic_rules(topic, timestamps_arr, resolved_thresholds)
        detections.extend(topic_detections)
        logs.extend(topic_logs)

    for topic, drifts in topic_drift.items():
        drift_detection, drift_log = _evaluate_drift_rule(
            topic, drifts, sorted(topic_times[topic]), resolved_thresholds
        )
        if drift_detection is not None:
            detections.append(drift_detection)
        logs.append(drift_log)

    observation_end = max(timestamp for timestamps in topic_times.values() for timestamp in timestamps)
    for topic, timestamps in topic_times.items():
        if topic not in cadence_topics:
            continue
        timestamps_arr = sorted(timestamps)
        if len(timestamps_arr) < 2:
            continue
        node_counts = topic_node_counts[topic]
        node = max(node_counts, key=lambda value: node_counts[value])
        silent_detections, silent_log = _evaluate_silent_rule(
            topic, node, timestamps_arr, observation_end, resolved_thresholds
        )
        detections.extend(silent_detections)
        logs.append(silent_log)

    aux_detections, aux_logs = _evaluate_auxiliary_rules(
        topic_times,
        topic_latency,
        log_entries,
        topic_payload,
        topic_nan,
        tf_pairs,
        resolved_thresholds,
        expected_hz,
        cadence_topics,
        observation_end,
    )
    detections.extend(aux_detections)
    logs.extend(aux_logs)

    result = {
        "summary": {
            "total_messages": total_messages,
            "total_detections": len(detections),
            "severity": "medium" if detections else "low",
        },
        "detections": detections,
        "thresholds": resolved_thresholds,
        "logs": logs,
    }
    logger.info(
        "diagnostics.analysis.completed",
        extra={
            "diagnostics": {
                "event": "diagnostics.analysis.completed",
                "level": "info",
                "message": "Diagnostics analysis completed.",
                "details": {
                    "total_messages": total_messages,
                    "total_detections": len(detections),
                    "thresholds": resolved_thresholds,
                },
            }
        },
    )
    return result
