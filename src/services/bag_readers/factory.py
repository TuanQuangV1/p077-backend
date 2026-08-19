"""Factory function to resolve and instantiate the appropriate Rosbag reader."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from src.services.bag_readers.db3_reader import DB3Reader
from src.services.bag_readers.mcap_reader import MCAPReader
from src.services.exceptions import CorruptedBagError, UnsupportedFormatError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from src.services.bag_readers.base import BaseBagReader


def get_bag_reader(
    path: str | Path,
    node_map: Mapping[str, str] | None = None,
) -> BaseBagReader:
    """Detect storage format and return the appropriate BaseBagReader instance.

    Supports single `.db3` files, `.mcap` files, or directories containing
    rosbag2 shards and optional metadata.yaml.

    Args:
        path: Path to bag file or directory.
        node_map: Optional explicit mapping of topic name -> node name.

    Returns:
        DB3Reader or MCAPReader instance.

    Raises:
        CorruptedBagError: Path does not exist or has unreadable content.
        UnsupportedFormatError: Format is not supported (.bag or unknown).
    """
    file_path = Path(path)
    if not file_path.exists():
        raise CorruptedBagError(f"Bag path not found: {file_path}", file_path=file_path)

    if file_path.is_file():
        ext = file_path.suffix.lower()
        if ext == ".db3":
            return DB3Reader(file_path, node_map=node_map)
        if ext == ".mcap":
            return MCAPReader(file_path, node_map=node_map)
        raise UnsupportedFormatError(
            f"Unsupported rosbag file format: {ext} ({file_path.name})",
            file_path=file_path,
        )

    if file_path.is_dir():
        # Check files inside directory
        files = list(file_path.iterdir())
        if any(f.is_file() and f.suffix.lower() == ".db3" for f in files):
            return DB3Reader(file_path, node_map=node_map)
        if any(f.is_file() and f.suffix.lower() == ".mcap" for f in files):
            return MCAPReader(file_path, node_map=node_map)
        raise UnsupportedFormatError(
            f"No valid .db3 or .mcap storage files found in directory: {file_path}",
            file_path=file_path,
        )

    raise UnsupportedFormatError(f"Invalid path type for rosbag: {file_path}", file_path=file_path)
