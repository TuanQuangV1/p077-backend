"""Rosbag Readers package: BaseBagReader abstraction and implementations."""

from src.services.bag_readers.base import (
    BagMetadata,
    BaseBagReader,
    TopicMetadata,
    UnifiedMessage,
)
from src.services.bag_readers.db3_reader import DB3Reader
from src.services.bag_readers.factory import get_bag_reader
from src.services.bag_readers.mcap_reader import MCAPReader

__all__ = [
    "BagMetadata",
    "BaseBagReader",
    "DB3Reader",
    "MCAPReader",
    "TopicMetadata",
    "UnifiedMessage",
    "get_bag_reader",
]
