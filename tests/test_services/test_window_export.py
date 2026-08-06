from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from src.services.window_export import export_windowed_jsonl, iter_window_jsonl_lines, iter_window_summaries

if TYPE_CHECKING:
    from pathlib import Path


def _message(timestamp: float, topic: str, header: float | None = None) -> dict[str, object]:
    row: dict[str, object] = {
        "timestamp": timestamp,
        "topic": topic,
        "node": "imu_node",
        "message_type": "sensor_msgs/msg/Imu",
    }
    if header is not None:
        row["header"] = header
    return row


STREAM = [
    # /imu window [0, 1): 3 messages at 20 Hz.
    _message(0.1, "/imu", header=0.0),
    _message(0.2, "/imu", header=0.1),
    _message(0.3, "/imu", header=0.2),
    # /imu window [1, 2)
    _message(1.1, "/imu", header=1.0),
    _message(1.2, "/imu", header=1.1),
]


def test_iter_window_summaries_groups_by_topic_and_window() -> None:
    summaries = list(iter_window_summaries(STREAM, window_sec=1.0))
    by_topic = {(s["window_start"], s["topic"]): s for s in summaries}
    assert len(by_topic) == 2
    assert by_topic[("1970-01-01T00:00:00+00:00", "/imu")]["count"] == 3
    assert by_topic[("1970-01-01T00:00:01+00:00", "/imu")]["count"] == 2


def test_summary_metrics_are_computed_per_window() -> None:
    summary = next(iter_window_summaries(STREAM, window_sec=1.0))
    assert summary["count"] == 3
    assert summary["actual_hz"] == pytest.approx(15.0)
    assert summary["max_gap_ms"] == pytest.approx(100.0)
    assert summary["jitter_ms"] == pytest.approx(0.0)
    assert summary["expected_hz"] is None


def test_expected_hz_map_fills_expected_rate() -> None:
    summary = next(iter_window_summaries(STREAM, window_sec=1.0, expected_hz={"/imu": 20.0}))
    assert summary["expected_hz"] == pytest.approx(20.0)


def test_clock_drift_is_median_bag_minus_header() -> None:
    summary = next(iter_window_summaries(STREAM, window_sec=1.0))
    assert summary["drift_ms"] == pytest.approx(100.0)


def test_no_header_stream_reports_null_drift() -> None:
    rows = [_message(0.1, "/imu"), _message(0.2, "/imu")]
    summary = next(iter_window_summaries(rows, window_sec=1.0))
    assert summary["drift_ms"] is None


def test_export_windowed_jsonl_writes_valid_jsonl(tmp_path: Path) -> None:
    out_path = tmp_path / "windows.jsonl"
    message_iter = iter(STREAM)
    written = export_windowed_jsonl(message_iter, out_path, window_sec=1.0)

    assert written == 2
    lines = out_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert {"window_start", "topic", "node", "message_type", "count"} <= set(first)


def test_iter_window_jsonl_lines_round_trips(tmp_path: Path) -> None:
    rows = [_message(0.1, "/imu")]
    lines = list(iter_window_jsonl_lines(rows, window_sec=1.0, expected_hz={"/imu": 50.0}))
    parsed = json.loads(lines[0])
    assert "count" in parsed
    assert parsed["expected_hz"] == 50.0
