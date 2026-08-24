"""MCAP-based Rosbag2 (.mcap) reader implementation."""

from __future__ import annotations

import logging
from contextlib import suppress
from typing import TYPE_CHECKING

import yaml

from src.services.bag_readers.base import BagMetadata, BaseBagReader, TopicMetadata, UnifiedMessage
from src.services.exceptions import CorruptedBagError, UnsupportedFormatError

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping
    from pathlib import Path

logger = logging.getLogger(__name__)


class MCAPReader(BaseBagReader):
    """Reader for MCAP-backed rosbag2 recordings (.mcap files or directory)."""

    def __init__(self, path: str | Path, node_map: Mapping[str, str] | None = None) -> None:
        super().__init__(path, node_map)
        self._mcap_file = self._resolve_mcap_file()

    def _resolve_mcap_file(self) -> Path:
        if self.path.is_file():
            if self.path.suffix.lower() != ".mcap":
                raise UnsupportedFormatError(
                    f"Expected .mcap file, got {self.path.name}",
                    file_path=self.path,
                )
            return self.path
        if self.path.is_dir():
            mcap_files = sorted(
                f for f in self.path.iterdir() if f.is_file() and f.suffix.lower() == ".mcap"
            )
            if not mcap_files:
                raise UnsupportedFormatError(
                    f"Directory does not contain any .mcap files: {self.path}",
                    file_path=self.path,
                )
            return mcap_files[0]
        raise CorruptedBagError(f"Path does not exist: {self.path}", file_path=self.path)

    def get_metadata(self) -> BagMetadata:
        """Extract metadata from metadata.yaml if present, or derive via MCAP summary section."""
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
                    file_size = self._mcap_file.stat().st_size if self._mcap_file.exists() else 0
                    return {
                        "storage_identifier": "mcap",
                        "duration_ns": dur_ns,
                        "duration_sec": int(dur_ns / 1_000_000_000),
                        "starting_time_ns": start_ns,
                        "message_count": msg_count,
                        "topics": topics,
                        "file_size_bytes": file_size,
                    }

        # Fallback: derive directly from MCAP index
        return self._read_metadata_from_mcap_index()

    def _read_metadata_from_mcap_index(self) -> BagMetadata:
        try:
            from rosbags.rosbag2.storage_mcap import (  # noqa: PLC0415
                McapReader as LowLevelMcapReader,
            )

            reader = LowLevelMcapReader(self._mcap_file)
            try:
                reader.open()
                stats = reader.statistics
                if stats is None:
                    raise CorruptedBagError(
                        f"MCAP file lacks required statistics section: {self._mcap_file.name}",
                        file_path=self._mcap_file,
                    )
                counts = stats.channel_message_counts
                topics: list[TopicMetadata] = [
                    {
                        "name": channel.topic,
                        "type": channel.schema,
                        "serialization_format": "cdr",
                        "offered_qos_profiles": {},
                        "message_count": counts.get(channel.id, 0),
                    }
                    for channel in sorted(reader.channels.values(), key=lambda c: c.id)
                ]
                start_ns = stats.start_time if stats.message_count else 0
                end_ns = stats.end_time if stats.message_count else 0
                dur_ns = max(0, end_ns - start_ns)

                return {
                    "storage_identifier": "mcap",
                    "duration_ns": dur_ns,
                    "duration_sec": int(dur_ns / 1_000_000_000),
                    "starting_time_ns": start_ns,
                    "message_count": stats.message_count,
                    "topics": topics,
                    "file_size_bytes": (
                        self._mcap_file.stat().st_size if self._mcap_file.exists() else 0
                    ),
                }
            finally:
                with suppress(Exception):
                    reader.close()
        except ImportError as exc:
            raise UnsupportedFormatError(
                "rosbags package is required to read .mcap files.",
                file_path=self._mcap_file,
            ) from exc
        except Exception as exc:
            raise CorruptedBagError(
                f"Failed to read MCAP index/metadata: {exc}",
                file_path=self._mcap_file,
            ) from exc

    def get_topics(self) -> list[TopicMetadata]:
        return self.get_metadata()["topics"]

    def stream_messages(self) -> Iterator[UnifiedMessage]:
        """Stream messages in ascending timestamp order with CDR fast-path decoding."""
        from src.services.bag_stream import iter_rosbag2_decoded  # noqa: PLC0415

        target_path = self.path if self.path.is_dir() else self._mcap_file
        try:
            for msg in iter_rosbag2_decoded(target_path, node_map=self.node_map):
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
        except Exception as exc:
            raise CorruptedBagError(
                f"Failed to stream MCAP messages from {target_path}: {exc}",
                file_path=target_path,
            ) from exc
