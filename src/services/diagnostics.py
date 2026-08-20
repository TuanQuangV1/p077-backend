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
import math
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
    positive_diffs = [interval for interval in diffs if interval > 0]
    max_interval = max(diffs)
    median_interval = float(statistics.median(positive_diffs)) if positive_diffs else 0.0
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
    interval_list = [b - a for a, b in pairwise(timestamps)]
    return float(statistics.pstdev(interval_list)) if len(interval_list) >= 2 else 0.0


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
    high_occurrence_min = thresholds["frequency_gap_high_occurrence_min"]
    gap_episodes = _threshold_episodes(spans, threshold)
    for start_sec, end_sec, worst, breaches in gap_episodes:
        detections.append(
            {
                "kind": "frequency_gap",
                "topic": topic,
                # A sustained run of breaches (cadence never recovers) is a
                # systemic degradation, not a transient blip: rank it higher
                # than a single long gap the same rule would otherwise also
                # catch (e.g. a dead topic), which already gets a `critical`
                # sibling detection from `silent_node` on the same window.
                "severity": "high" if breaches >= high_occurrence_min else "medium",
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


def _clock_drift_detection(
    topic: str,
    start_sec: float,
    end_sec: float,
    drift_sec: float,
    jitter_sec: float,
    occurrence_count: int,
    threshold: float,
    pattern: str,
    ramp_critical_rate: float,
    rate_ms_per_sec: float | None = None,
) -> dict[str, Any]:
    """Build a clock_drift detection with pattern-appropriate severity.

    Ground-truth evidence across the framework's dataset shows severity
    tracks *how* the clock is wrong, not just by how much: a sudden jump
    (`step` — a node restart resetting the clock) is always critical, even
    for a small offset (observed as low as 2.4s and still critical). A
    free-running clock drifting at a constant rate (`ramp`) is only critical
    once its rate is fast enough to matter (``ramp_critical_rate``); a slower
    drift stays `high` regardless of how long it has had to accumulate.
    """
    evidence: dict[str, Any] = {
        "drift_sec": round(drift_sec, 4),
        "jitter_sec": round(jitter_sec, 4),
        "threshold_sec": round(threshold, 4),
        "direction": "backward" if drift_sec > 0 else "forward",
        "occurrence_count": occurrence_count,
        "pattern": pattern,
    }
    if pattern == "ramp":
        severity = "critical" if rate_ms_per_sec is not None and abs(rate_ms_per_sec) >= ramp_critical_rate else "high"
        evidence["drift_rate_ms_per_sec"] = round(rate_ms_per_sec or 0.0, 4)
    else:
        severity = "critical"
    return {
        "kind": "clock_drift",
        "topic": topic,
        "severity": severity,
        "confidence": 0.88,
        "tSec": start_sec,
        "endSec": end_sec,
        "evidence": evidence,
    }


def _split_at_change_points(
    ep_samples: list[tuple[float, float]],
    threshold: float,
) -> list[list[tuple[float, float]]]:
    """Split one drift episode wherever the signal jumps abruptly to a new level.

    Two distinct clock faults occurring back-to-back with no healthy gap
    between them (e.g. a ramp immediately followed by a sudden backward jump)
    stay one contiguous episode under the |drift| > threshold grouping — but
    a single line fit can't describe both a ramp and a step, so the whole
    episode fails classification and the fault is lost entirely. A genuine
    step or ramp changes by only a tiny amount between consecutive messages
    (bounded by the publish rate); a jump between two independent fault
    regimes instead shows one delta that dwarfs every other delta in the
    episode. Splitting there lets each side be classified on its own.
    """
    if len(ep_samples) < 4:
        return [ep_samples]
    deltas = [abs(ep_samples[i][1] - ep_samples[i - 1][1]) for i in range(1, len(ep_samples))]
    median_delta = statistics.median(deltas)
    split_points = [i + 1 for i, delta in enumerate(deltas) if delta > max(threshold, median_delta * 50)]
    if not split_points:
        return [ep_samples]
    segments = []
    start_idx = 0
    for idx in split_points:
        segments.append(ep_samples[start_idx:idx])
        start_idx = idx
    segments.append(ep_samples[start_idx:])
    return [segment for segment in segments if segment]


def _fit_clock_drift_ramp(
    ep_samples: list[tuple[float, float]],
    threshold: float,
    max_rate_ms_per_sec: float,
) -> tuple[float, float, float] | None:
    """Fit a straight line to an episode's drift samples and test how well it fits.

    A free-running (unsynced) sensor clock drifts at a roughly constant rate,
    so its offset over time is a straight line with only small residual
    noise — unlike real network/processing latency, which has no such trend.
    Returns ``(slope_sec_per_sec, residual_std_sec, total_drift_sec)`` when
    the fit is tight (residual std-dev below ``threshold``), the accumulated
    drift is itself non-trivial, and the rate stays under
    ``max_rate_ms_per_sec`` — a handful of points spanning a fraction of a
    second can fit a "line" perfectly by chance, but the resulting slope is
    numerically unstable (dividing by a near-zero time span) and physically
    implausible for a real clock; that noise, not a genuine ramp, is rejected
    here. Otherwise returns ``None``.
    """
    if len(ep_samples) < 3:
        return None
    timestamps = [ts for ts, _ in ep_samples]
    values = [drift for _, drift in ep_samples]
    try:
        fit = statistics.linear_regression(timestamps, values)
    except statistics.StatisticsError:
        return None
    residuals = [value - (fit.intercept + fit.slope * ts) for ts, value in ep_samples]
    residual_spread = statistics.pstdev(residuals)
    total_drift = fit.slope * (timestamps[-1] - timestamps[0])
    if (
        residual_spread < threshold
        and abs(total_drift) > threshold
        and abs(fit.slope) * 1000.0 <= max_rate_ms_per_sec
    ):
        return fit.slope, residual_spread, total_drift
    return None


def _evaluate_drift_rule(
    topic: str,
    samples: list[tuple[float, float]],
    thresholds: dict[str, float],
) -> tuple[list[dict[str, Any]], dict[str, Any], list[tuple[float, float]]]:
    """Flag sustained clock-offset episodes, distinct from fluctuating network latency.

    A node that restarts and resets its clock produces a near-constant
    header/bag-time offset for as long as the stale clock is in effect — the
    offset's own std-dev stays small relative to its magnitude. A sensor
    running an unsynced free-running clock instead produces an offset that
    grows *linearly* over time (a constant drift rate) — not stable, but not
    random either: its deviation from a straight line stays small. Real
    network or processing latency looks similar in *average* magnitude but
    fluctuates message to message with no such trend. A whole-topic median
    (the previous approach) also misses a fault confined to part of the
    recording: it gets diluted by the healthy majority of messages and never
    crosses the threshold. This evaluates sustained runs (via the same
    threshold-episode grouping as the other rules) and reports the stable or
    linear ones as `clock_drift`; a fluctuating run is left for
    :func:`_evaluate_header_latency_rule` to explain as latency instead.

    ``samples`` holds ``(timestamp, signed drift)`` pairs, time-ordered, where
    ``drift = bag_timestamp - header_timestamp``: positive means the header
    stamp reads *behind* the bag/receive time (a backward clock jump).

    Returns the detections, the rule-evaluation log entry, and the
    ``(start, end)`` windows that fired — callers exclude those windows from
    `header_latency` so the same corrupted stretch is not double-labelled.
    """
    threshold = float(thresholds["clock_drift_max_sec"])
    min_count = int(thresholds["clock_drift_min_count"])
    ramp_critical_rate = float(thresholds["clock_drift_ramp_critical_rate_ms_per_sec"])
    min_span = float(thresholds["clock_drift_min_span_sec"])
    max_rate = float(thresholds["clock_drift_max_rate_ms_per_sec"])

    raw_episodes: list[tuple[float, float, list[tuple[float, float]]]] = []
    start: float | None = None
    end = 0.0
    episode_samples: list[tuple[float, float]] = []
    for ts, drift in samples:
        if abs(drift) > threshold:
            if start is None:
                start, episode_samples = ts, []
            episode_samples.append((ts, drift))
            end = ts
        elif start is not None:
            raw_episodes.append((start, end, episode_samples))
            start = None
    if start is not None:
        raw_episodes.append((start, end, episode_samples))

    detections: list[dict[str, Any]] = []
    fired_windows: list[tuple[float, float]] = []
    for _start_sec, _end_sec, raw_ep_samples in raw_episodes:
        for ep_samples in _split_at_change_points(raw_ep_samples, threshold):
            start_sec, end_sec = ep_samples[0][0], ep_samples[-1][0]
            # A driver that buffers messages and flushes them in a batch (the
            # `burst` fault) crams many messages into a near-zero bag-time span;
            # any drift/rate computed over that span is numerically unstable
            # (dividing by ~0 time), not a real clock signature. Require a
            # minimum real duration before trusting either classification below.
            if len(ep_samples) < min_count or end_sec - start_sec < min_span:
                continue
            values = [drift for _, drift in ep_samples]
            spread = statistics.pstdev(values)
            if spread < threshold:
                # Stable offset: a step jump (e.g. a node restart resetting the clock).
                mean_drift = statistics.fmean(values)
                detections.append(
                    _clock_drift_detection(
                        topic, start_sec, end_sec, mean_drift, spread, len(ep_samples), threshold, "step",
                        ramp_critical_rate,
                    )
                )
                fired_windows.append((start_sec, end_sec))
                continue

            # Not stable — check whether it is instead a clean linear ramp (a
            # free-running clock drifting at a constant rate) rather than jitter.
            ramp = _fit_clock_drift_ramp(ep_samples, threshold, max_rate)
            if ramp is not None:
                slope, residual_spread, total_drift = ramp
                detections.append(
                    _clock_drift_detection(
                        topic,
                        start_sec,
                        end_sec,
                        total_drift,
                        residual_spread,
                        len(ep_samples),
                        threshold,
                        "ramp",
                        ramp_critical_rate,
                        rate_ms_per_sec=slope * 1000.0,
                    )
                )
                fired_windows.append((start_sec, end_sec))

    drift_log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "clock_drift",
        "level": "debug",
        "message": "Evaluated clock drift rule.",
        "details": {
            "topic": topic,
            "message_count": len(samples),
            "threshold_sec": round(threshold, 4),
            "episode_count": len(detections),
            "detected": bool(detections),
        },
    }
    if detections:
        drift_log_payload["level"] = "warn"
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": drift_log_payload})
    else:
        logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": drift_log_payload})
    return detections, drift_log_payload, fired_windows


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
    critical_span = float(thresholds["silent_node_critical_sec"])
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
            "severity": "critical" if worst >= critical_span else "medium",
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

    resolved_expected: float | None = None
    if expected_hz is not None and topic in expected_hz:
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
    exclude_windows: list[tuple[float, float]] | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Flag sustained publish/header timestamp skew above 100 ms.

    ``latencies`` holds ``(bag_timestamp, publish_lag_sec)`` pairs. The rule
    fires when at least ``_HEADER_LATENCY_MIN_SUSTAINED`` messages lag more than
    ``header_latency_max_ms`` behind their header stamp. ``exclude_windows``
    (from :func:`_evaluate_drift_rule`) removes samples already explained by a
    stable clock-offset episode, so the same corrupted stretch is not
    double-labelled as both `clock_drift` and `header_latency`.
    """
    threshold_sec = float(thresholds["header_latency_max_ms"]) / 1000.0
    if exclude_windows:
        latencies = [
            (ts, lag)
            for ts, lag in latencies
            if not any(start <= ts <= end for start, end in exclude_windows)
        ]
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
    pairs: list[tuple[float, str, str, tuple[float, float, float] | None]],
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

    ``pairs`` holds ``(timestamp, frame_id, child_frame_id, translation)``
    tuples — one per broadcast edge observed on the topic (a single ``/tf``
    message can batch several edges), not necessarily time-ordered.
    ``translation`` is unused here; see :func:`_evaluate_tf_conflict_rule`.
    """
    detections: list[dict[str, Any]] = []
    logs: list[dict[str, Any]] = []

    missing_threshold = float(thresholds["tf_max_missing_span_sec"])
    critical_gap_sec = float(thresholds["tf_missing_gap_critical_sec"])
    by_child: dict[str, list[tuple[float, str]]] = defaultdict(list)
    for ts, frame, child, _translation in pairs:
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
                    "severity": "critical" if worst >= critical_gap_sec else "high",
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
    for ts, frame, child, _translation in sorted(pairs, key=lambda pair: pair[0]):
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


def _evaluate_tf_conflict_rule(
    topic: str,
    pairs: list[tuple[float, str, str, tuple[float, float, float] | None]],
    thresholds: dict[str, float],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Flag an edge whose translation repeatedly jumps between two disagreeing publishers.

    Two nodes launched to publish the same ``(parent, child)`` edge produce a
    broadcast stream that alternates between two unrelated trajectories — the
    edge "teleports" back and forth every time the other publisher's message
    lands, instead of moving continuously. This never shows up as a gap
    (`tf_missing_gap` sees a healthy publish rate) or a re-parenting
    (`tf_drift_jump` sees the same parent throughout), so it needs its own
    signal: repeated large jumps in the *value*, not the timing.

    Differs from a one-time relocalization jump (e.g. AMCL correcting once)
    by repeating: at least ``tf_conflict_min_jumps`` jumps larger than
    ``tf_jump_distance_m``, clustered within ``tf_conflict_window_sec`` of
    each other. A single jump that then settles is left unflagged.

    ``pairs`` holds ``(timestamp, frame_id, child_frame_id, translation)``
    tuples; entries without a translation (e.g. flat dicts built by callers
    that never populated it) are skipped, so this rule stays silent rather
    than false-flagging when geometry is unavailable.
    """
    jump_distance = float(thresholds["tf_jump_distance_m"])
    window_sec = float(thresholds["tf_conflict_window_sec"])
    min_jumps = int(thresholds["tf_conflict_min_jumps"])

    by_child: dict[str, list[tuple[float, tuple[float, float, float]]]] = defaultdict(list)
    for ts, _frame, child, translation in pairs:
        if child and translation is not None:
            by_child[child].append((ts, translation))

    detections: list[dict[str, Any]] = []
    for child, entries in by_child.items():
        entries.sort(key=lambda entry: entry[0])
        jump_events = [
            (ts_b, math.dist(pos_a, pos_b))
            for (_, pos_a), (ts_b, pos_b) in pairwise(entries)
            if math.dist(pos_a, pos_b) > jump_distance
        ]
        # `_threshold_episodes` groups by span *duration* exceeding a
        # threshold; jump clustering instead needs consecutive jump events
        # *closer together* than `window_sec` to merge into one episode, so
        # it is grouped directly here rather than reusing that helper.
        episodes: list[tuple[float, float, float, int]] = []
        ep_start: float | None = None
        ep_end = ep_worst = 0.0
        ep_count = 0
        prev_ts: float | None = None
        for ts, distance in jump_events:
            if prev_ts is not None and ts - prev_ts > window_sec:
                if ep_start is not None and ep_count >= min_jumps:
                    episodes.append((ep_start, ep_end, ep_worst, ep_count))
                ep_start = None
            if ep_start is None:
                ep_start, ep_worst, ep_count = ts, distance, 0
            ep_worst = max(ep_worst, distance)
            ep_end = ts
            ep_count += 1
            prev_ts = ts
        if ep_start is not None and ep_count >= min_jumps:
            episodes.append((ep_start, ep_end, ep_worst, ep_count))

        for start_sec, end_sec, worst_distance, occurrence in episodes:
            # A conflict on `odom` (the map->odom edge, AMCL-owned) corrupts every
            # downstream frame in a standard Nav2 TF tree, so it is critical; a
            # conflict lower in the tree (e.g. odom->base_footprint) stays high.
            # Ground-truth evidence: `child_frame == "odom"` -> critical in both
            # observed cases, `base_footprint` -> high in both observed cases.
            severity = "critical" if child == "odom" else "high"
            detections.append(
                {
                    "kind": "tf_conflict",
                    "topic": topic,
                    "severity": severity,
                    "confidence": 0.82,
                    "tSec": start_sec,
                    "endSec": end_sec,
                    "evidence": {
                        "child_frame": child,
                        "max_jump_m": round(worst_distance, 4),
                        "threshold_m": round(jump_distance, 4),
                        "occurrence_count": occurrence,
                    },
                }
            )

    log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "tf_conflict",
        "level": "debug",
        "message": "Evaluated TF conflicting-publisher rule.",
        "details": {
            "topic": topic,
            "threshold_m": jump_distance,
            "edge_count": len(by_child),
            "detected": bool(detections),
            "episode_count": len(detections),
        },
    }
    if detections:
        log_payload["level"] = "warn"
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": log_payload})
    else:
        logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": log_payload})
    return detections, log_payload


def _evaluate_data_quality_rule(
    topic: str,
    kind: str,
    evidence_ratio_key: str,
    samples: list[tuple[float, float]],
    ratio_threshold: float,
    min_count: int,
    severity: str,
    confidence: float,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Flag a sustained ratio of corrupted payload values (NaN or out-of-range).

    ``samples`` holds ``(timestamp, ratio)`` pairs, time-ordered — the
    fraction of one message's numeric fields (e.g. LaserScan ``ranges``, or
    an Imu's angular_velocity/linear_acceleration) that decoded as NaN, or
    fell outside a valid envelope. A message counts as corrupted once its
    ratio exceeds ``ratio_threshold``; a corrupted stretch of at least
    ``min_count`` consecutive messages is one incident, reported by its real
    duration (e.g. a failing photodiode segment lasting minutes) instead of
    once per message. Shared by `payload_nan` and `payload_out_of_range`,
    which differ only in which ratio field feeds them and their severity.
    """
    detections: list[dict[str, Any]] = []
    log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": kind,
        "level": "debug",
        "message": f"Evaluated {kind} rule.",
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
                "kind": kind,
                "topic": topic,
                "severity": severity,
                "confidence": confidence,
                "tSec": start_sec,
                "endSec": end_sec,
                "evidence": {
                    evidence_ratio_key: round(worst_ratio, 4),
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
    topic_out_of_range: dict[str, list[tuple[float, float]]],
    tf_pairs: dict[str, list[tuple[float, str, str, tuple[float, float, float] | None]]],
    thresholds: dict[str, float],
    expected_hz: Mapping[str, float] | None,
    cadence_topics: set[str],
    observation_end: float,
    clock_drift_windows: dict[str, list[tuple[float, float]]],
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
        latency_detection, latency_log = _evaluate_header_latency_rule(
            topic, latencies, thresholds, clock_drift_windows.get(topic)
        )
        if latency_detection is not None:
            detections.append(latency_detection)
        logs.append(latency_log)

    for topic, entries in log_entries.items():
        detections.extend(_evaluate_log_severity_rules(topic, sorted(entries), thresholds))

    for topic, payloads in topic_payload.items():
        detections.extend(_evaluate_payload_rules(topic, sorted(payloads), thresholds))

    for topic, samples in topic_nan.items():
        nan_detections, nan_log = _evaluate_data_quality_rule(
            topic,
            "payload_nan",
            "max_nan_ratio",
            sorted(samples),
            float(thresholds["payload_nan_ratio_min"]),
            int(thresholds["payload_nan_min_count"]),
            severity="critical",
            confidence=0.87,
        )
        detections.extend(nan_detections)
        logs.append(nan_log)

    for topic, samples in topic_out_of_range.items():
        oor_detections, oor_log = _evaluate_data_quality_rule(
            topic,
            "payload_out_of_range",
            "max_out_of_range_ratio",
            sorted(samples),
            float(thresholds["payload_out_of_range_ratio_min"]),
            int(thresholds["payload_out_of_range_min_count"]),
            severity="high",
            confidence=0.83,
        )
        detections.extend(oor_detections)
        logs.append(oor_log)

    for topic, pairs in tf_pairs.items():
        tf_detections, tf_logs = _evaluate_tf_rules(topic, pairs, thresholds, observation_end)
        detections.extend(tf_detections)
        logs.extend(tf_logs)

    for topic, pairs in tf_pairs.items():
        conflict_detections, conflict_log = _evaluate_tf_conflict_rule(topic, pairs, thresholds)
        detections.extend(conflict_detections)
        logs.append(conflict_log)

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
      median_interval * frequency_gap_multiplier)`. Severity is `high` when an
      episode sustains at least `frequency_gap_high_occurrence_min` breaches
      (a systemic cadence drop, not a single blip), else `medium`.
    - `message_drop_burst`: a single inter-message interval exceeding the
      absolute ceiling `max_gap_burst_sec` (independent of the median).
    - `timestamp_jitter`: the population std-dev of inter-message intervals of
      a topic exceeding `timestamp_jitter_max_sec`.
    - `silent_node`: for each node with >= 2 messages, a node is flagged when
      its active span (last - first timestamp) reaches `silent_node_min_span_sec`.
      Severity is `critical` once the span reaches `silent_node_critical_sec`,
      else `medium`.
    - `clock_drift`: a sustained run of `>= clock_drift_min_count` messages
      whose |bag timestamp - header timestamp| exceeds `clock_drift_max_sec`
      and either stays stable (std-dev below `clock_drift_max_sec` — a node
      clock reset producing a near-constant offset, kind `"step"`) or follows
      a clean linear ramp (an unsynced free-running clock drifting at a
      constant rate; residual std-dev after a line fit stays below
      `clock_drift_max_sec`, kind `"ramp"`). Two distinct clock faults with no
      healthy gap between them are split at the abrupt jump joining them
      before classification. Fluctuating latency with no such pattern is left
      for `header_latency`. Severity: `step` is always `critical` (a sudden
      jump is dangerous regardless of size); `ramp` is `critical` only once
      its rate reaches `clock_drift_ramp_critical_rate_ms_per_sec`, else
      `high`. Only evaluated when messages carry a `header` field.
    - `hz_drop` / `hz_drop_critical`: a time window whose effective publish rate
      falls more than `hz_drop_warn_pct` / `hz_drop_critical_pct` below the
      expected rate (from `expected_hz`, else the peak window rate). Requires at
      least `hz_drop_min_messages` messages.
    - `header_latency`: at least `_HEADER_LATENCY_MIN_SUSTAINED` messages whose
      bag timestamp lags their `header.stamp` by more than `header_latency_max_ms`,
      excluding any stretch already explained by a `clock_drift` episode.
    - `log_fatal` / `log_error_burst` / `log_warn_storm`: counts of fatal/error/
      warn entries on /rosout-style topics crossing `log_*_min_count`.
    - `payload_zero_byte`: at least `payload_zero_byte_min_count` messages whose
      `payload_bytes` field is 0.
    - `payload_nan`: a stretch of at least `payload_nan_min_count` consecutive
      messages whose `nan_ratio` field (fraction of e.g. LaserScan `ranges` or
      an Imu's angular_velocity/linear_acceleration that decoded as NaN)
      exceeds `payload_nan_ratio_min`.
    - `payload_out_of_range`: a stretch of at least
      `payload_out_of_range_min_count` consecutive messages whose
      `out_of_range_ratio` field (fraction of readings outside a valid
      envelope — a LaserScan's own `range_min`/`range_max`, or an Imu's
      physically-implausible ceiling) exceeds `payload_out_of_range_ratio_min`.
    - `tf_missing_gap` / `tf_drift_jump`: per-edge broadcast gaps and frame
      re-parenting on `/tf` / `/tf_static` topics, keyed by `child_frame_id` so
      one silent edge is not masked by other edges still publishing. Severity
      is `critical` when the gap reaches `tf_missing_gap_critical_sec`, else
      `high`.
    - `tf_conflict`: an edge whose translation repeatedly (>= `tf_conflict_min_jumps`
      times, clustered within `tf_conflict_window_sec`) jumps more than
      `tf_jump_distance_m` and back — two publishers disagreeing on the same
      edge, distinct from `tf_drift_jump`'s one-time re-parenting.

    Detections whose onset falls within `pre_roll_grace_sec` of that topic's
    own first observed message are dropped: recorder/simulator warm-up
    produces irregular timing on every topic's first few messages, which
    otherwise reads identically to a real anomaly.

    Args:
        messages: Iterable of message dicts. Recognized fields include
            `timestamp`, `topic`, `node`, `message_type`, optional `header`
            (seconds), `frame_id`, `child_frame_id`, `transforms` (list of
            `{frame_id, child_frame_id, translation}` for a batched `/tf`
            publish), `level`, `payload_bytes`, `nan_ratio` and
            `out_of_range_ratio`.
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
    topic_latency: dict[str, list[tuple[float, float]]] = defaultdict(list)
    topic_payload: dict[str, list[tuple[float, int]]] = defaultdict(list)
    topic_nan: dict[str, list[tuple[float, float]]] = defaultdict(list)
    topic_out_of_range: dict[str, list[tuple[float, float]]] = defaultdict(list)
    log_entries: dict[str, list[tuple[float, str]]] = defaultdict(list)
    tf_pairs: dict[str, list[tuple[float, str, str, tuple[float, float, float] | None]]] = defaultdict(list)
    total_messages = 0
    for message in messages:
        try:
            timestamp = float(message["timestamp"])
            topic = str(message["topic"])
            node = str(message["node"])
        except (KeyError, TypeError, ValueError):
            # Skip malformed messages that are missing required fields.
            logger.debug(
                "diagnostics.message_skipped",
                extra={
                    "diagnostics": {
                        "event": "diagnostics.message_skipped",
                        "level": "debug",
                        "details": {"keys": list(message.keys()) if hasattr(message, "keys") else []},
                    }
                },
            )
            continue
        total_messages += 1
        topic_times[topic].append(timestamp)
        topic_message_types[topic].add(str(message.get("message_type") or ""))
        topic_node_counts[topic][node] += 1
        header = message.get("header")
        if header is not None:
            drift = timestamp - float(header)
            topic_latency[topic].append((timestamp, drift))
        payload_bytes = message.get("payload_bytes")
        if payload_bytes is not None:
            topic_payload[topic].append((timestamp, int(payload_bytes)))
        nan_ratio = message.get("nan_ratio")
        if nan_ratio is not None:
            topic_nan[topic].append((timestamp, float(nan_ratio)))
        out_of_range_ratio = message.get("out_of_range_ratio")
        if out_of_range_ratio is not None:
            topic_out_of_range[topic].append((timestamp, float(out_of_range_ratio)))
        level = message.get("level")
        if level is not None:
            log_entries[topic].append((timestamp, str(level).lower()))
        if topic in _TF_TOPICS:
            transforms = message.get("transforms")
            if transforms:
                for transform in transforms:
                    tr_frame = str(transform.get("frame_id") or "")
                    tr_child = str(transform.get("child_frame_id") or "")
                    tr_translation = transform.get("translation")
                    if tr_translation is not None:
                        tr_translation = tuple(float(v) for v in tr_translation)
                    if tr_frame or tr_child:
                        tf_pairs[topic].append((timestamp, tr_frame, tr_child, tr_translation))
            else:
                frame_id = str(message.get("frame_id") or "")
                child_frame_id = str(message.get("child_frame_id") or "")
                if frame_id or child_frame_id:
                    tf_pairs[topic].append((timestamp, frame_id, child_frame_id, None))

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

    clock_drift_windows: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for topic, samples in topic_latency.items():
        drift_detections, drift_log, drift_windows = _evaluate_drift_rule(
            topic, sorted(samples), resolved_thresholds
        )
        detections.extend(drift_detections)
        logs.append(drift_log)
        if drift_windows:
            clock_drift_windows[topic].extend(drift_windows)

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
        topic_out_of_range,
        tf_pairs,
        resolved_thresholds,
        expected_hz,
        cadence_topics,
        observation_end,
        clock_drift_windows,
    )
    detections.extend(aux_detections)
    logs.extend(aux_logs)

    # Recorder/simulator warm-up produces irregular publish timing for the
    # first few seconds of every topic's own life, independent of any real
    # fault; without a filter these look identical to a genuine anomaly. No
    # injected fault in the framework's dataset starts inside the observed
    # warm-up window (worst case ~6.3s), so excluding each topic's own first
    # `pre_roll_grace_sec` never masks a real incident.
    pre_roll_grace = float(resolved_thresholds["pre_roll_grace_sec"])
    if pre_roll_grace > 0:
        topic_start = {topic: min(timestamps) for topic, timestamps in topic_times.items()}
        detections = [
            d
            for d in detections
            if float(d.get("tSec", 0.0)) >= topic_start.get(str(d.get("topic", "")), float("-inf")) + pre_roll_grace
        ]

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
