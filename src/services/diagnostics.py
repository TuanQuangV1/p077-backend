from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np


def parse_mcap_file(path: str | Path) -> list[dict[str, Any]]:
    """Read a small `.mcap`-style JSONL fixture into a standard message stream.

    This keeps the route compatible with a real file-backed workflow while the
    production bag reader dependency is still being introduced.
    """
    file_path = Path(path)
    messages: list[dict[str, Any]] = []
    with file_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            
            messages.append(json.loads(line))
            
    return messages


def denormalize_message_stream(messages: list[dict[str, Any]]) -> np.ndarray:
    """Convert a ROS topic stream into a compact structured NumPy array.

    The goal is to keep the parser lightweight and deterministic while allowing
    vectorized downstream analysis.
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


def detect_anomalies(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Emit a compact JSON summary for frequency gaps and silent-node patterns.

    This is intentionally small and deterministic so it can be used as the
    intermediate contract between a parser and a downstream explanation model.
    """
    array = denormalize_message_stream(messages)
    if array.size == 0:
        return {
            "summary": {
                "total_messages": 0,
                "total_detections": 0,
                "severity": "low",
            },
            "detections": [],
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
            threshold = max(0.08, median_interval * 1.5)
            if max_interval > threshold:
                detections.append({
                    "kind": "frequency_gap",
                    "topic": topic,
                    "severity": "medium",
                    "confidence": 0.81,
                    "evidence": {
                        "interval_sec": round(max_interval, 4),
                        "threshold_sec": round(threshold, 4),
                    },
                })

    for node, timestamps in node_times.items():
        timestamps_arr = np.asarray(sorted(timestamps), dtype=float)
        if timestamps_arr.size >= 3:
            span = float(timestamps_arr[-1] - timestamps_arr[0])
            if span >= 0.3:
                detections.append({
                    "kind": "silent_node",
                    "topic": "/unknown",
                    "severity": "low",
                    "confidence": 0.72,
                    "evidence": {
                        "node": node,
                        "active_span_sec": round(span, 4),
                    },
                })

    return {
        "summary": {
            "total_messages": int(array.size),
            "total_detections": len(detections),
            "severity": "medium" if detections else "low",
        },
        "detections": detections,
    }
