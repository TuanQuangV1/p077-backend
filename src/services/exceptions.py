"""Custom domain exception hierarchy for Rosbag parsing and stream extraction.

Provides rich error context (file path, topic, byte offset/position, reason)
so the application layer and API can provide precise, actionable error messages.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path


class RosbagParseError(RuntimeError):
    """Base exception for all rosbag parsing and stream extraction errors."""

    def __init__(
        self,
        message: str,
        *,
        file_path: str | Path | None = None,
        topic: str | None = None,
        position: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.file_path = str(file_path) if file_path is not None else None
        self.topic = topic
        self.position = position
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        """Convert exception context to a structured dictionary."""
        return {
            "error_type": self.__class__.__name__,
            "message": self.message,
            "file_path": self.file_path,
            "topic": self.topic,
            "position": self.position,
            "details": self.details,
        }

    def __str__(self) -> str:
        parts = [self.message]
        if self.file_path:
            parts.append(f"file={self.file_path}")
        if self.topic:
            parts.append(f"topic={self.topic}")
        if self.position is not None:
            parts.append(f"pos={self.position}")
        return " | ".join(parts)


class CorruptedBagError(RosbagParseError):
    """Raised when a rosbag file has invalid headers, truncated records, or unparseable blocks."""


class UnsupportedFormatError(RosbagParseError):
    """Raised when the rosbag format or storage plugin is not supported or cannot be determined."""


class DecodeError(RosbagParseError):
    """Raised when a specific message payload fails CDR or deserialization."""


class SchemaMismatchError(RosbagParseError):
    """Raised when a message's binary schema does not match the registered typestore definitions."""


class BagIndexMissingError(RosbagParseError):
    """Raised when an MCAP file lacks required index/summary structures for non-linear lookups."""
