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

_MESSAGE_DTYPE = [
    ("timestamp", "f8"),
    ("topic", "U64"),
    ("node", "U64"),
    ("message_type", "U128"),
    ("dt_sec", "f8"),
]


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
        arr = np.diff(np.asarray(timestamps, dtype=float))
        return (
            float(np.median(arr)),
            float(np.max(arr)),
            int(np.argmax(arr)),
        )
    diffs = [b - a for a, b in pairwise(timestamps)]
    max_interval = max(diffs)
    return float(statistics.median(diffs)), max_interval, diffs.index(max_interval)


def _timestamp_jitter(timestamps: list[float]) -> float:
    """Population std-dev of consecutive inter-message intervals (seconds)."""
    if len(timestamps) < 3:
        return 0.0
    if len(timestamps) >= _MIN_NUMPY_MESSAGES:
        return float(np.std(np.diff(np.asarray(timestamps, dtype=float))))
    return float(statistics.pstdev(b - a for a, b in pairwise(timestamps)))


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
    median_interval, max_interval, gap_index = _gap_stats(timestamps_arr)
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
    if max_interval > threshold:
        detections.append(
            {
                "kind": "frequency_gap",
                "topic": topic,
                "severity": "medium",
                "confidence": 0.81,
                "tSec": float(timestamps_arr[gap_index]),
                "endSec": float(timestamps_arr[gap_index + 1]),
                "evidence": {
                    "interval_sec": round(max_interval, 4),
                    "threshold_sec": round(threshold, 4),
                },
            }
        )
        gap_log_payload["level"] = "warn"
        gap_log_payload["details"]["detected"] = True
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": gap_log_payload})
    else:
        gap_log_payload["details"]["detected"] = False
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
    if max_interval > burst_threshold:
        detections.append(
            {
                "kind": "message_drop_burst",
                "topic": topic,
                "severity": "medium",
                "confidence": 0.8,
                "tSec": float(timestamps_arr[gap_index]),
                "endSec": float(timestamps_arr[gap_index + 1]),
                "evidence": {
                    "max_gap_sec": round(max_interval, 4),
                    "threshold_sec": round(burst_threshold, 4),
                },
            }
        )
        burst_log_payload["level"] = "warn"
        burst_log_payload["details"]["detected"] = True
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": burst_log_payload})
    else:
        burst_log_payload["details"]["detected"] = False
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
    node: str,
    timestamps_arr: list[float],
    node_topic_counts: dict[str, dict[str, int]],
    thresholds: dict[str, float],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Evaluate the silent-node rule for one node."""
    span = float(timestamps_arr[-1] - timestamps_arr[0])
    resolved_span_threshold = thresholds["silent_node_min_span_sec"]
    topic_counts = node_topic_counts[node]
    dominant_topic = max(topic_counts, key=lambda t: topic_counts[t])
    node_log_payload: dict[str, Any] = {
        "event": "diagnostics.rule_evaluation",
        "rule": "silent_node",
        "level": "debug",
        "message": "Evaluated silent node rule.",
        "details": {
            "node": node,
            "topic": dominant_topic,
            "message_count": len(timestamps_arr),
            "active_span_sec": round(span, 4),
            "silent_node_min_span_sec": resolved_span_threshold,
        },
    }
    if span >= resolved_span_threshold:
        node_log_payload["level"] = "warn"
        node_log_payload["details"]["detected"] = True
        logger.warning("diagnostics.rule_detected", extra={"diagnostics": node_log_payload})
        return (
            {
                "kind": "silent_node",
                "topic": dominant_topic,
                "severity": "low",
                "confidence": 0.72,
                "tSec": float(timestamps_arr[0]),
                "endSec": float(timestamps_arr[-1]),
                "evidence": {
                    "node": node,
                    "active_span_sec": round(span, 4),
                },
            },
            node_log_payload,
        )
    node_log_payload["details"]["detected"] = False
    logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": node_log_payload})
    return None, node_log_payload


def detect_anomalies(
    messages: Iterable[Mapping[str, Any]],
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Emit a compact JSON summary for timing anomalies in a message stream.

    The stream is consumed exactly once, so `messages` may be a lazy iterator
    (e.g. :func:`src.services.bag_stream.iter_bag_messages`) without loading a
    whole bag into memory; only the per-topic / per-node aggregates are kept.

    Five rules are evaluated per message stream:

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

    Args:
        messages: Iterable of message dicts (`timestamp`, `topic`, `node`,
            `message_type`, optional `header` in seconds).
        thresholds: Optional overrides merged over the persisted defaults via
            `merge_diagnostics_thresholds`. `None` uses the defaults as-is.

    Returns:
        Dict with keys: `summary` (total_messages, total_detections, severity),
        `detections` (list of detected anomalies with kind/severity/confidence/
        evidence), `thresholds` (the resolved thresholds used) and `logs`
        (per-rule evaluation log entries).
    """
    resolved_thresholds = merge_diagnostics_thresholds(thresholds=thresholds)
    logs: list[dict[str, Any]] = []

    topic_times: dict[str, list[float]] = defaultdict(list)
    node_times: dict[str, list[float]] = defaultdict(list)
    node_topic_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    topic_drift: dict[str, list[float]] = defaultdict(list)
    total_messages = 0
    for message in messages:
        timestamp = float(message["timestamp"])
        topic = str(message["topic"])
        node = str(message["node"])
        total_messages += 1
        topic_times[topic].append(timestamp)
        node_times[node].append(timestamp)
        node_topic_counts[node][topic] += 1
        header = message.get("header")
        if header is not None:
            topic_drift[topic].append(timestamp - float(header))

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

    detections: list[dict[str, Any]] = []
    for topic, timestamps in topic_times.items():
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

    for node, timestamps in node_times.items():
        timestamps_arr = sorted(timestamps)
        if len(timestamps_arr) < 2:
            continue
        silent_detection, silent_log = _evaluate_silent_rule(
            node, timestamps_arr, node_topic_counts, resolved_thresholds
        )
        if silent_detection is not None:
            detections.append(silent_detection)
        logs.append(silent_log)

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
