"""Low-level streaming rosbag message readers.

Parses rosbag2 SQLite bags (``.db3``) one message at a time instead of loading
the whole bag into memory (no ``fetchall``, no full-list materialization).

Two reading strategies are provided:

- :func:`iter_rosbag2_messages`: timing-only path backed by plain ``sqlite3``.
  It yields ``topic`` / ``message_type`` / ``timestamp`` and never touches the
  payload column, so it works on minimal bags and needs no extra dependency.
- :func:`iter_rosbag2_decoded`: best-effort light decode via the optional
  ``rosbags`` package. Each message is deserialized just long enough to read
  ``header.stamp`` / ``header.frame_id`` (enough for clock-drift diagnostics);
  the full message object is discarded immediately. The node name, which ROS2
  bags do not store, is inferred heuristically from the topic (or overridden by
  an explicit ``node_map``).

:func:`iter_bag_messages` is the unified entry point: it prefers the decoded
path and degrades gracefully to the timing-only path when ``rosbags`` is not
installed or the bag is not a readable rosbag2 database.
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping

logger = logging.getLogger(__name__)

_Message = dict[str, Any]


def _infer_node(topic: str, node_map: Mapping[str, str] | None) -> str:
    """Best-effort node name from the topic, honoring an explicit map first.

    ROS2 bags do not store publisher node names directly, so the node is taken
    from the first path segment of the topic (``/imu/data`` -> ``imu``) unless
    the caller provides an explicit ``topic -> node`` mapping.
    """
    if node_map:
        mapped = node_map.get(topic)
        if mapped:
            return mapped
    segments = [segment for segment in topic.split("/") if segment]
    return segments[0] if segments else ""


def _header_stamp(message: object) -> float | None:
    """Return ``header.stamp`` (seconds) if the decoded message has a header."""
    header = getattr(message, "header", None)
    if header is None:
        return None
    stamp = getattr(header, "stamp", None)
    if stamp is None:
        return None
    sec = getattr(stamp, "sec", 0)
    nanosec = getattr(stamp, "nanosec", 0)
    if sec is None and nanosec is None:
        return None
    return float(sec or 0) + float(nanosec or 0) * 1e-9


def _frame_id(message: object) -> str:
    header = getattr(message, "header", None)
    frame_id = getattr(header, "frame_id", "") if header is not None else ""
    return str(frame_id or "")


def _child_frame_id(message: object) -> str:
    header = getattr(message, "header", None)
    child = getattr(header, "child_frame_id", "") if header is not None else ""
    if child:
        return str(child)
    # tf2_msgs/msg/TFMessage carries a list of transforms; fall back to the
    # first transform's child_frame_id so tf topics are readable without the
    # full message being retained.
    transforms = getattr(message, "transforms", None)
    if transforms:
        first = transforms[0]
        child = getattr(getattr(first, "child_frame_id", ""), "frame_id", "") or getattr(first, "child_frame_id", "")
        return str(child)
    return ""


def _log_level(message: object) -> str | None:
    """Map a ``rosgraph_msgs/msg/Log`` level int to a severity label."""
    level = getattr(message, "level", None)
    if not isinstance(level, int):
        return None
    for flag, label in ((16, "fatal"), (8, "error"), (4, "warn"), (2, "info"), (1, "debug")):
        if level & flag:
            return label
    return None


def iter_rosbag2_messages(path: str | Path, include_size: bool = False) -> Iterator[_Message]:
    """Yield rosbag2 messages in ascending timestamp order.

    Only the ``topics``/``messages`` tables are read and message payloads are
    never decoded. Timestamps are converted from nanoseconds to seconds. Rows
    are materialized and sorted in Python with :mod:`numpy` (by timestamp),
    rather than leaving SQLite to run an unindexed external sort on large
    bags, which is substantially slower for medium/large datasets.

    Args:
        path: Path to the ``.db3`` rosbag2 database.
        include_size: When True, also read ``LENGTH(data)`` (never the BLOB
            itself) into a ``payload_bytes`` field for bandwidth/payload-size
            diagnostics.

    Yields:
        Dicts with ``timestamp`` (seconds), ``topic``, ``node`` (empty),
        ``message_type`` and, when ``include_size`` is set, ``payload_bytes``
        in timestamp order.

    Raises:
        sqlite3.DatabaseError: The file is not a readable rosbag2 database.
    """
    file_path = Path(path)
    conn = sqlite3.connect(f"file:{file_path.resolve()}?mode=ro", uri=True)
    try:
        select = "SELECT t.name, t.type, m.timestamp"
        if include_size:
            select += ", LENGTH(m.data)"
        rows = conn.execute(f"{select} FROM messages m JOIN topics t ON m.topic_id = t.id").fetchall()
    finally:
        conn.close()

    order = np.argsort([row[2] for row in rows], kind="stable")
    for row in np.asarray(rows)[order]:
        topic, message_type, timestamp = row[:3]
        message: dict[str, Any] = {
            "timestamp": int(timestamp) / 1_000_000_000,
            "topic": str(topic),
            "node": "",
            "message_type": str(message_type),
        }
        if include_size:
            message["payload_bytes"] = int(row[3])
        yield message


def iter_rosbag2_decoded(
    path: str | Path,
    node_map: Mapping[str, str] | None = None,
) -> Iterator[_Message]:
    """Light-decode a real rosbag2 bag with headers, streaming its messages.

    Requires the optional ``rosbags`` package. Only the message header is kept
    (``header.stamp`` as ``header`` seconds, ``frame_id`` string); payloads are
    never retained. A directory path opens the whole recording; a file path
    (e.g. one ``.db3`` shard) is read in isolation so shards can be consumed
    independently without duplication.

    Args:
        path: Path to a rosbag2 directory or a single bag file (``.db3``).
        node_map: Optional explicit ``topic -> node`` mapping.

    Yields:
        Dicts with ``timestamp`` (bag time, seconds), ``topic``, ``node``,
        ``message_type``, ``header`` (``header.stamp`` in seconds or ``None``),
        ``frame_id``, ``child_frame_id``, ``payload_bytes`` and ``level`` for
        ``/rosout`` log messages. Payload bodies are never retained.

    Raises:
        ImportError: The ``rosbags`` package is not installed.
        ValueError: The bag cannot be opened as a rosbag2 database.
    """
    file_path = Path(path)

    from rosbags.highlevel import AnyReader  # noqa: PLC0415 - optional dependency

    try:
        with AnyReader([file_path]) as reader:
            for connection, timestamp_ns, rawdata in reader.messages():
                message = reader.deserialize(rawdata, connection.msgtype) if rawdata else None
                yield {
                    "timestamp": timestamp_ns / 1_000_000_000,
                    "topic": connection.topic,
                    "node": _infer_node(connection.topic, node_map),
                    "message_type": connection.msgtype,
                    "header": _header_stamp(message),
                    "frame_id": _frame_id(message),
                    "child_frame_id": _child_frame_id(message),
                    "payload_bytes": len(rawdata),
                    "level": _log_level(message),
                }
    except Exception as exc:
        raise ValueError(f"not a readable rosbag2 database: {file_path}") from exc


def _is_db3_path(path: str | Path) -> bool:
    """Return True when `path` denotes rosbag2 SQLite (`.db3`) storage.

    A ``.db3`` file is SQLite; a directory is SQLite-backed when it contains a
    ``.db3`` shard. Anything else (``.mcap`` files, ``.bag`` files, or
    directories without a ``.db3`` shard) is treated as non-SQLite so the
    SQLite fallback is never attempted against a format ``sqlite3`` cannot
    open.
    """
    file_path = Path(path)
    if file_path.is_dir():
        return any(f.suffix.lower() == ".db3" for f in file_path.iterdir() if f.is_file())
    return file_path.suffix.lower() == ".db3"


def _bag_format(path: str | Path) -> str:
    """Return a human-friendly storage format label for error reporting."""
    file_path = Path(path)
    if file_path.is_dir():
        for f in file_path.iterdir():
            if f.is_file() and f.suffix.lower() in {".db3", ".mcap", ".bag"}:
                return f.suffix.lower()
        return "bag directory"
    return file_path.suffix.lower() or "bag"


def iter_bag_messages(
    path: str | Path,
    node_map: Mapping[str, str] | None = None,
) -> Iterator[_Message]:
    """Unified streaming bag reader with graceful decode fallback.

    Prefers the light-decoded path (:func:`iter_rosbag2_decoded`) and falls
    back to the timing-only SQLite reader whenever the decode is unavailable
    (no ``rosbags`` package) or the bag is not a full rosbag2 database, so
    callers can always consume the stream without loading it into memory.

    The SQLite fallback only applies to ``.db3`` storage. For other formats
    (e.g. ``.mcap``) SQLite can never open the file, so a decode failure
    raises a clear error instead of surfacing a confusing
    ``sqlite3.DatabaseError``.

    Args:
        path: Path to a bag file or rosbag2 directory.
        node_map: Optional explicit ``topic -> node`` mapping for the decoded path.

    Returns:
        Message stream shared by the analysis pipeline and window export.
    """
    try:
        yield from iter_rosbag2_decoded(path, node_map=node_map)
        return
    except (ImportError, ValueError, sqlite3.DatabaseError) as exc:
        if not _is_db3_path(path):
            raise RuntimeError(
                f"rosbags package required to read {_bag_format(path)} files, but decode failed: {exc}"
            ) from exc
        logger.warning(
            "bag_stream.decode_fallback",
            extra={
                "diagnostics": {
                    "event": "bag.stream.decode_fallback",
                    "level": "warning",
                    "bag": str(path),
                    "reason": str(exc),
                }
            },
        )
    yield from iter_rosbag2_messages(path)
