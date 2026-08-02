from __future__ import annotations

import json
import logging
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from src.services.diagnostics_config import merge_diagnostics_thresholds

logger = logging.getLogger(__name__)


def parse_rosbag2_db3(path: str | Path) -> list[dict[str, Any]]:
    """Read a rosbag2 SQLite bag (`*.db3`) into a standard message stream.

    Only the `topics`/`messages` tables are read (message payloads are never
    decoded), which is enough for timing-based diagnostics. Timestamps are
    converted from nanoseconds to seconds.

    Args:
        path: Path to the `.db3` rosbag2 database.

    Returns:
        List of message dicts (`timestamp` in seconds, `topic`, `node`,
        `message_type`).

    Raises:
        sqlite3.DatabaseError: The file is not a readable rosbag2 database.
    """
    file_path = Path(path)
    conn = sqlite3.connect(f"file:{file_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT t.name, t.type, m.timestamp "
            "FROM messages m JOIN topics t ON m.topic_id = t.id "
            "ORDER BY m.timestamp"
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "timestamp": timestamp / 1_000_000_000,
            "topic": topic,
            "node": "",
            "message_type": message_type,
        }
        for topic, message_type, timestamp in rows
    ]


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


def denormalize_message_stream(messages: list[dict[str, Any]]) -> np.ndarray:
    """Convert a ROS topic stream into a compact structured NumPy array.

    The goal is to keep the parser lightweight and deterministic while allowing
    vectorized downstream analysis.

    Each message must contain `timestamp` (float), `topic`, `node` and
    `message_type` keys. `dt_sec` is computed as the delta to the previous
    message timestamp (0 for the first message).

    Args:
        messages: List of message dicts from a parsed ROS stream.

    Returns:
        Structured NumPy array with fields `timestamp`, `topic`, `node`,
        `message_type` and `dt_sec`. Returns an empty array with the same
        dtype when `messages` is empty.
    """
    if not messages:
        return np.array([], dtype=[
            ("timestamp", "f8"),
            ("topic", "U64"),
            ("node", "U64"),
            ("message_type", "U128"),
            ("dt_sec", "f8"),
        ])

    rows = []
    previous_timestamp: float | None = None
    for message in messages:
        timestamp = float(message["timestamp"])
        topic = str(message["topic"])
        node = str(message["node"])
        message_type = str(message["message_type"])
        dt_sec = 0.0 if previous_timestamp is None else timestamp - previous_timestamp
        rows.append((timestamp, topic, node, message_type, dt_sec))
        previous_timestamp = timestamp

    return np.array(rows, dtype=[
        ("timestamp", "f8"),
        ("topic", "U64"),
        ("node", "U64"),
        ("message_type", "U128"),
        ("dt_sec", "f8"),
    ])


def detect_anomalies(
    messages: list[dict[str, Any]],
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Emit a compact JSON summary for frequency gaps and silent-node patterns.

    This is intentionally small and deterministic so it can be used as the
    intermediate contract between a parser and a downstream explanation model.

    Two rules are evaluated per message stream:

    - `frequency_gap`: for each topic with >= 2 messages, a gap is flagged when
      the max inter-message interval exceeds `max(frequency_gap_min_threshold_sec,
      median_interval * frequency_gap_multiplier)`.
    - `silent_node`: for each node with >= 3 messages, a node is flagged when
      its active span (last - first timestamp) reaches `silent_node_min_span_sec`.

    Args:
        messages: List of message dicts (`timestamp`, `topic`, `node`, ...).
        thresholds: Optional overrides merged over the persisted defaults via
            `merge_diagnostics_thresholds`. `None` uses the defaults as-is.

    Returns:
        Dict with keys: `summary` (total_messages, total_detections, severity),
        `detections` (list of detected anomalies with kind/severity/confidence/
        evidence), `thresholds` (the resolved thresholds used) and `logs`
        (per-rule evaluation log entries).
    """
    resolved_thresholds = merge_diagnostics_thresholds(thresholds=thresholds)
    array = denormalize_message_stream(messages)
    logs: list[dict[str, Any]] = []

    if array.size == 0:
        log_payload = {
            "event": "diagnostics.analysis.empty_input",
            "level": "info",
            "message": "No messages available for diagnostics.",
            "details": {
                "message_count": 0,
                "thresholds": resolved_thresholds,
            },
        }
        logger.info("diagnostics.analysis.empty_input", extra={"diagnostics": log_payload})
        return {
            "summary": {
                "total_messages": 0,
                "total_detections": 0,
                "severity": "low",
            },
            "detections": [],
            "thresholds": resolved_thresholds,
            "logs": [log_payload],
        }

    topic_times: dict[str, list[float]] = defaultdict(list)
    node_times: dict[str, list[float]] = defaultdict(list)
    for row in array:
        topic = str(row["topic"])
        node = str(row["node"])
        timestamp = float(row["timestamp"])
        topic_times[topic].append(timestamp)
        node_times[node].append(timestamp)

    detections: list[dict[str, Any]] = []
    for topic, timestamps in topic_times.items():
        timestamps_arr = np.asarray(sorted(timestamps), dtype=float)
        if timestamps_arr.size >= 2:
            intervals = np.diff(timestamps_arr)
            median_interval = float(np.median(intervals)) if intervals.size else 0.0
            max_interval = float(np.max(intervals)) if intervals.size else 0.0
            gap_index = int(np.argmax(intervals)) if intervals.size else 0
            minimum_threshold = resolved_thresholds["frequency_gap_min_threshold_sec"]
            multiplier = resolved_thresholds["frequency_gap_multiplier"]
            threshold = max(minimum_threshold, median_interval * multiplier)
            log_payload = {
                "event": "diagnostics.rule_evaluation",
                "rule": "frequency_gap",
                "level": "debug",
                "message": "Evaluated frequency gap rule.",
                "details": {
                    "topic": topic,
                    "message_count": int(timestamps_arr.size),
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
                detection = {
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
                detections.append(detection)
                log_payload["level"] = "warn"
                log_payload["details"]["detected"] = True
                logger.warning("diagnostics.rule_detected", extra={"diagnostics": log_payload})
            else:
                log_payload["details"]["detected"] = False
                logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": log_payload})
            logs.append(log_payload)

    for node, timestamps in node_times.items():
        timestamps_arr = np.asarray(sorted(timestamps), dtype=float)
        if timestamps_arr.size >= 3:
            span = float(timestamps_arr[-1] - timestamps_arr[0])
            resolved_span_threshold = resolved_thresholds["silent_node_min_span_sec"]
            log_payload = {
                "event": "diagnostics.rule_evaluation",
                "rule": "silent_node",
                "level": "debug",
                "message": "Evaluated silent node rule.",
                "details": {
                    "node": node,
                    "message_count": int(timestamps_arr.size),
                    "active_span_sec": round(span, 4),
                    "silent_node_min_span_sec": resolved_span_threshold,
                },
            }
            if span >= resolved_span_threshold:
                detection = {
                    "kind": "silent_node",
                    "topic": "/unknown",
                    "severity": "low",
                    "confidence": 0.72,
                    "tSec": float(timestamps_arr[0]),
                    "endSec": float(timestamps_arr[-1]),
                    "evidence": {
                        "node": node,
                        "active_span_sec": round(span, 4),
                    },
                }
                detections.append(detection)
                log_payload["level"] = "warn"
                log_payload["details"]["detected"] = True
                logger.warning("diagnostics.rule_detected", extra={"diagnostics": log_payload})
            else:
                log_payload["details"]["detected"] = False
                logger.debug("diagnostics.rule_evaluated", extra={"diagnostics": log_payload})
            logs.append(log_payload)

    result = {
        "summary": {
            "total_messages": int(array.size),
            "total_detections": len(detections),
            "severity": "medium" if detections else "low",
        },
        "detections": detections,
        "thresholds": resolved_thresholds,
        "logs": logs,
    }
    logger.info("diagnostics.analysis.completed", extra={"diagnostics": {
        "event": "diagnostics.analysis.completed",
        "level": "info",
        "message": "Diagnostics analysis completed.",
        "details": {
            "total_messages": int(array.size),
            "total_detections": len(detections),
            "thresholds": resolved_thresholds,
        },
    }})
    return result
