"""SQLite-based Rosbag2 (.db3) reader implementation."""

from __future__ import annotations

import logging
import sqlite3
from contextlib import suppress
from typing import TYPE_CHECKING

import yaml

from src.services import perf
from src.services.bag_readers.base import BagMetadata, BaseBagReader, TopicMetadata, UnifiedMessage
from src.services.exceptions import CorruptedBagError, UnsupportedFormatError

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping
    from pathlib import Path

logger = logging.getLogger(__name__)

_DEFAULT_BATCH_SIZE = 5000


class DB3Reader(BaseBagReader):
    """Reader for SQLite-backed rosbag2 recordings (.db3 files or directory)."""

    def __init__(self, path: str | Path, node_map: Mapping[str, str] | None = None) -> None:
        super().__init__(path, node_map)
        self._db_file = self._resolve_db_file()

    def _resolve_db_file(self) -> Path:
        if self.path.is_file():
            if self.path.suffix.lower() != ".db3":
                raise UnsupportedFormatError(
                    f"Expected .db3 file, got {self.path.name}",
                    file_path=self.path,
                )
            return self.path
        if self.path.is_dir():
            db3_files = sorted(
                f for f in self.path.iterdir() if f.is_file() and f.suffix.lower() == ".db3"
            )
            if not db3_files:
                raise UnsupportedFormatError(
                    f"Directory does not contain any .db3 files: {self.path}",
                    file_path=self.path,
                )
            return db3_files[0]
        raise CorruptedBagError(f"Path does not exist: {self.path}", file_path=self.path)

    def get_metadata(self) -> BagMetadata:
        """Extract metadata from metadata.yaml if present, or derive directly from SQLite tables."""
        folder = self.path if self.path.is_dir() else self.path.parent
        meta_yaml = folder / "metadata.yaml"
        if meta_yaml.exists():
            with suppress(Exception):
                with meta_yaml.open("r", encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}
                raw_info = data.get("rosbag2_bagfile_information", {})
                if isinstance(raw_info, dict) and "duration" in raw_info:
                    dur_ns = int(raw_info.get("duration", {}).get("nanoseconds", 0))
                    start_ns = int(
                        raw_info.get("starting_time", {}).get("nanoseconds_since_epoch", 0)
                    )
                    msg_count = int(raw_info.get("message_count", 0))
                    topics_raw = raw_info.get("topics_with_message_count", [])
                    topics: list[TopicMetadata] = [
                        {
                            "name": t.get("topic_metadata", {}).get("name", ""),
                            "type": t.get("topic_metadata", {}).get("type", ""),
                            "serialization_format": t.get("topic_metadata", {}).get(
                                "serialization_format", "cdr"
                            ),
                            "offered_qos_profiles": t.get("topic_metadata", {}).get(
                                "offered_qos_profiles", {}
                            ),
                            "message_count": int(t.get("message_count", 0)),
                        }
                        for t in topics_raw
                    ]
                    file_size = self._db_file.stat().st_size if self._db_file.exists() else 0
                    return {
                        "storage_identifier": "sqlite3",
                        "duration_ns": dur_ns,
                        "duration_sec": int(dur_ns / 1_000_000_000),
                        "starting_time_ns": start_ns,
                        "message_count": msg_count,
                        "topics": topics,
                        "file_size_bytes": file_size,
                    }

        # Fallback: derive directly from DB
        return self._read_metadata_from_sqlite()

    def _read_metadata_from_sqlite(self) -> BagMetadata:
        try:
            conn = perf.open_connection(
                f"file:{self._db_file.resolve()}?mode=ro",
                uri=True,
                source=f"db3.meta:{self._db_file.name}",
            )
            try:
                tables = {
                    row[0]
                    for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
                if "topics" not in tables:
                    raise CorruptedBagError(
                        f"Missing required 'topics' table in {self._db_file.name}",
                        file_path=self._db_file,
                    )
                topics_rows = conn.execute(
                    "SELECT id, name, type FROM topics ORDER BY id"
                ).fetchall()
                if "messages" in tables:
                    summary_row = conn.execute(
                        "SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM messages"
                    ).fetchone()
                    count_rows = dict(
                        conn.execute(
                            "SELECT topic_id, COUNT(*) FROM messages GROUP BY topic_id"
                        ).fetchall()
                    )
                else:
                    summary_row = (0, 0, 0)
                    count_rows = {}
            finally:
                conn.close()
        except sqlite3.Error as exc:
            raise CorruptedBagError(
                f"Failed to read SQLite rosbag tables: {exc}",
                file_path=self._db_file,
            ) from exc

        total_msgs = summary_row[0] if summary_row and summary_row[0] is not None else 0
        start_ns = summary_row[1] if summary_row and summary_row[1] is not None else 0
        end_ns = summary_row[2] if summary_row and summary_row[2] is not None else start_ns
        dur_ns = max(0, end_ns - start_ns)

        topics: list[TopicMetadata] = [
            {
                "name": str(name),
                "type": str(mtype),
                "serialization_format": "cdr",
                "offered_qos_profiles": {},
                "message_count": count_rows.get(tid, 0),
            }
            for tid, name, mtype in topics_rows
        ]

        return {
            "storage_identifier": "sqlite3",
            "duration_ns": dur_ns,
            "duration_sec": int(dur_ns / 1_000_000_000),
            "starting_time_ns": start_ns,
            "message_count": total_msgs,
            "topics": topics,
            "file_size_bytes": self._db_file.stat().st_size if self._db_file.exists() else 0,
        }

    def get_topics(self) -> list[TopicMetadata]:
        return self.get_metadata()["topics"]

    def stream_messages(self) -> Iterator[UnifiedMessage]:
        """Stream messages in ascending timestamp order, using decoded path when possible."""
        from src.services.bag_stream import iter_bag_messages  # noqa: PLC0415

        # Delegate to high-performance iter_bag_messages which uses CDR fast-path
        # and degrades gracefully to SQLite timing-only mode.
        target_path = self.path if self.path.is_dir() else self._db_file
        for msg in iter_bag_messages(target_path, node_map=self.node_map):
            yield {
                "timestamp": float(msg["timestamp"]),
                "topic": str(msg["topic"]),
                "node": str(msg.get("node") or self.infer_node(str(msg["topic"]))),
                "message_type": str(msg.get("message_type") or ""),
                "header": msg.get("header"),
                "frame_id": str(msg.get("frame_id") or ""),
                "child_frame_id": str(msg.get("child_frame_id") or ""),
                "payload_bytes": int(msg.get("payload_bytes", 0)),
                "level": msg.get("level"),
            }
