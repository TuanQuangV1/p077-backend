"""Time-window summarization of a message stream into compact JSONL rows.

The denormalized stream is not written out message-by-message (too verbose for
both disk and LLM context). Instead messages are grouped into fixed time
windows per topic, and each window is summarized into a single compact JSON
row: message count, actual vs expected rate, largest gap, jitter and clock
drift. This cuts the exported volume by roughly two orders of magnitude while
keeping every signal the diagnostics rules need.

The summarizer consumes a lazy message iterator (see
:mod:`src.services.bag_stream`) and only holds one small state per
(topic, window) in memory, so arbitrarily large bags can be exported without
loading them into RAM.
"""

from __future__ import annotations

import json
import math
import statistics
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator, Mapping

DEFAULT_WINDOW_SEC = 10.0

_DEFAULT_FLUSH_BATCH = 500


class _WindowState:
    """Accumulated statistics for one (topic, time window)."""

    __slots__ = (
        "count",
        "drift_samples",
        "first_ts",
        "gaps",
        "last_ts",
        "message_type",
        "node",
        "topic",
        "window_start",
    )

    def __init__(
        self,
        window_start: float,
        topic: str,
        node: str,
        message_type: str,
        timestamp: float,
    ) -> None:
        self.window_start = window_start
        self.topic = topic
        self.node = node
        self.message_type = message_type
        self.first_ts = timestamp
        self.last_ts = timestamp
        self.count = 0
        self.gaps: list[float] = []
        self.drift_samples: list[float] = []


def _window_start(timestamp: float, window_sec: float) -> float:
    return math.floor(timestamp / window_sec) * window_sec


def iter_window_summaries(
    messages: Iterable[dict[str, Any]],
    window_sec: float = DEFAULT_WINDOW_SEC,
    expected_hz: Mapping[str, float] | None = None,
) -> Iterator[dict[str, Any]]:
    """Summarize a timestamp-ordered message stream into per-window rows.

    Messages must be dicts with at least ``timestamp`` (seconds) and ``topic``;
    ``node``, ``message_type`` and ``header`` (``header.stamp`` in seconds) are
    picked up when present. Only one state per (topic, window) is kept in
    memory, plus the previous timestamp per topic.

    Args:
        messages: Lazy stream of message dicts, time-ordered per topic.
        window_sec: Width of each aggregation window in seconds.
        expected_hz: Optional ``topic -> expected publish rate`` map used to
            fill the ``expected_hz`` column of the summaries.

    Yields:
        One dict per (topic, window): ``window_start`` (ISO-8601 UTC),
        ``topic``, ``node``, ``message_type``, ``count``, ``expected_hz``,
        ``actual_hz``, ``max_gap_ms``, ``jitter_ms`` (std of intervals) and
        ``drift_ms`` (median of ``bag timestamp - header.stamp``, ``None``
        when the stream carries no header information).
    """
    if window_sec <= 0:
        raise ValueError("window_sec must be positive")

    active: dict[tuple[float, str], _WindowState] = {}
    previous_ts: dict[str, float] = {}

    for message in messages:
        timestamp = float(message["timestamp"])
        topic = str(message["topic"])
        window = _window_start(timestamp, window_sec)
        key = (window, topic)
        state = active.get(key)
        if state is None:
            for stale_key, stale_state in list(active.items()):
                if stale_key[0] < window:
                    yield _summarize(stale_state, expected_hz)
                    del active[stale_key]
            state = _WindowState(
                window,
                topic,
                str(message.get("node", "")),
                str(message.get("message_type", "")),
                timestamp,
            )
            active[key] = state

        state.count += 1
        state.last_ts = timestamp
        previous = previous_ts.get(topic)
        if previous is not None and timestamp >= previous:
            state.gaps.append(timestamp - previous)
        previous_ts[topic] = timestamp

        header = message.get("header")
        if header is not None:
            state.drift_samples.append(timestamp - float(header))

    for state in list(active.values()):
        yield _summarize(state, expected_hz)


def _summarize(
    state: _WindowState,
    expected_hz: Mapping[str, float] | None,
) -> dict[str, Any]:
    span = state.last_ts - state.first_ts
    actual_hz = state.count / span if span > 0 and state.count > 1 else None
    max_gap_ms = max(state.gaps) * 1000.0 if state.gaps else None
    jitter_ms = statistics.stdev(state.gaps) * 1000.0 if len(state.gaps) >= 2 else None
    drift_ms = statistics.median(state.drift_samples) * 1000.0 if state.drift_samples else None
    expected = expected_hz.get(state.topic) if expected_hz else None

    return {
        "window_start": datetime.fromtimestamp(state.window_start, UTC).isoformat(),
        "topic": state.topic,
        "node": state.node,
        "message_type": state.message_type,
        "count": state.count,
        "expected_hz": round(float(expected), 4) if expected is not None else None,
        "actual_hz": round(actual_hz, 4) if actual_hz is not None else None,
        "max_gap_ms": round(max_gap_ms, 2) if max_gap_ms is not None else None,
        "jitter_ms": round(jitter_ms, 2) if jitter_ms is not None else None,
        "drift_ms": round(drift_ms, 2) if drift_ms is not None else None,
    }


def iter_window_jsonl_lines(
    messages: Iterable[dict[str, Any]],
    window_sec: float = DEFAULT_WINDOW_SEC,
    expected_hz: Mapping[str, float] | None = None,
) -> Iterator[str]:
    """Yield JSONL lines, one per (topic, window) summary."""
    for summary in iter_window_summaries(messages, window_sec=window_sec, expected_hz=expected_hz):
        yield json.dumps(summary, ensure_ascii=False)


def export_windowed_jsonl(
    messages: Iterable[dict[str, Any]],
    out_path: str | Path,
    window_sec: float = DEFAULT_WINDOW_SEC,
    expected_hz: Mapping[str, float] | None = None,
    flush_batch: int = _DEFAULT_FLUSH_BATCH,
) -> int:
    """Stream window summaries into a JSONL file, flushing in batches.

    The input stream is consumed lazily: memory stays bounded by the active
    window states and the in-memory flush batch, independent of the total
    number of messages.

    Args:
        messages: Lazy stream of message dicts (see :mod:`src.services.bag_stream`).
        out_path: Destination ``.jsonl`` file (created/truncated).
        window_sec: Aggregation window width in seconds.
        expected_hz: Optional ``topic -> expected rate`` map.
        flush_batch: Number of summary lines to buffer before each disk write.

    Returns:
        Number of window summaries written.
    """
    out_file = Path(out_path)
    written = 0
    batch: list[str] = []
    with out_file.open("w", encoding="utf-8") as handle:
        for line in iter_window_jsonl_lines(messages, window_sec=window_sec, expected_hz=expected_hz):
            batch.append(line)
            written += 1
            if len(batch) >= flush_batch:
                handle.write("\n".join(batch) + "\n")
                batch.clear()
        if batch:
            handle.write("\n".join(batch) + "\n")
    return written
