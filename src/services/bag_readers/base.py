"""Base abstraction and protocol for Rosbag readers.

All format-specific readers (DB3, MCAP) implement this interface to ensure
loose coupling, consistency, and open-closed architecture.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypedDict

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping


class TopicMetadata(TypedDict):
    """Metadata describing a single topic in a rosbag."""

    name: str
    type: str
    serialization_format: str
    offered_qos_profiles: dict[str, Any]
    message_count: int


class BagMetadata(TypedDict):
    """Overall metadata describing a rosbag recording."""

    storage_identifier: str
    duration_ns: int
    duration_sec: int
    starting_time_ns: int
    message_count: int
    topics: list[TopicMetadata]
    file_size_bytes: int


class UnifiedMessage(TypedDict, total=False):
    """Standardized normalized message shape yielded to the Detection Engine."""

    timestamp: float  # seconds since epoch
    topic: str
    node: str
    message_type: str
    header: float | None  # header.stamp in seconds if present
    frame_id: str
    child_frame_id: str
    payload_bytes: int
    level: str | None  # log severity for /rosout


class BaseBagReader(ABC):
    """Abstract Base Class for format-specific rosbag readers."""

    def __init__(self, path: str | Path, node_map: Mapping[str, str] | None = None) -> None:
        self.path = Path(path)
        self.node_map = node_map or {}

    @abstractmethod
    def get_metadata(self) -> BagMetadata:
        """Extract high-level metadata (duration, total counts, storage type) without full scan."""
        ...

    @abstractmethod
    def get_topics(self) -> list[TopicMetadata]:
        """Extract list of discovered topics with message types and counts."""
        ...

    @abstractmethod
    def stream_messages(self) -> Iterator[UnifiedMessage]:
        """Stream normalized messages in ascending chronological order."""
        ...

    def infer_node(self, topic: str) -> str:
        """Helper to resolve node name from explicit map or topic path heuristic."""
        if self.node_map and topic in self.node_map:
            return self.node_map[topic]
        segments = [s for s in topic.split("/") if s]
        return segments[0] if segments else ""
