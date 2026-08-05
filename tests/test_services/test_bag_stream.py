from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING, Any

import numpy as np
import pytest
from rosbags.rosbag2 import Writer
from rosbags.typesys import Stores, get_typestore

from src.services.bag_stream import (
    _infer_node,
    iter_bag_messages,
    iter_rosbag2_decoded,
    iter_rosbag2_messages,
)

if TYPE_CHECKING:
    from pathlib import Path


def _make_minimal_bag(path: Path, rows: list[tuple[int, int]]) -> Path:
    """Create a minimal rosbag2-style SQLite bag with out-of-order rows."""
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT, type TEXT)")
    conn.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER, timestamp INTEGER, data BLOB)")
    conn.execute("INSERT INTO topics VALUES (1, '/scan', 'sensor_msgs/msg/LaserScan')")
    conn.executemany(
        "INSERT INTO messages(topic_id, timestamp) VALUES (1, ?)",
        [(timestamp_ns,) for timestamp_ns in rows],
    )
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def rosbag2_bag_dir(tmp_path: Path) -> Path:
    """Write a real rosbag2 (.db3 + metadata.yaml) bag with two IMU messages."""

    typestore = get_typestore(Stores.ROS2_HUMBLE)
    imu_cls = typestore.get_msgdef("sensor_msgs/msg/Imu").cls
    header_cls = typestore.get_msgdef("std_msgs/msg/Header").cls
    time_cls = typestore.get_msgdef("builtin_interfaces/msg/Time").cls
    vector_cls = typestore.get_msgdef("geometry_msgs/msg/Vector3").cls
    quat_cls = typestore.get_msgdef("geometry_msgs/msg/Quaternion").cls

    bag_dir = tmp_path / "bag"
    with Writer(bag_dir, version=9) as writer:
        conn = writer.add_connection("/imu/data", "sensor_msgs/msg/Imu", typestore=typestore)
        # Written out of timestamp order to prove the reader sorts by time.
        for bag_ns, header_sec in ((2_000_000_000, 2), (1_000_000_000, 1)):
            header = header_cls(stamp=time_cls(sec=header_sec, nanosec=0), frame_id="base_link")
            imu = imu_cls(
                header=header,
                orientation=quat_cls(0.0, 0.0, 0.0, 1.0),
                orientation_covariance=np.zeros(9),
                angular_velocity=vector_cls(0.0, 0.0, 0.0),
                angular_velocity_covariance=np.zeros(9),
                linear_acceleration=vector_cls(0.0, 0.0, 9.8),
                linear_acceleration_covariance=np.zeros(9),
            )
            rawdata = typestore.serialize_cdr(imu, conn.msgtype)
            writer.write(conn, bag_ns, rawdata)
    return bag_dir


def test_iter_rosbag2_messages_orders_by_timestamp(tmp_path: Path) -> None:
    bag_path = _make_minimal_bag(tmp_path / "ordered.db3", [2_000_000_000, 1_000_000_000])
    rows = list(iter_rosbag2_messages(bag_path))
    assert [row["timestamp"] for row in rows] == [1.0, 2.0]
    assert rows[0]["topic"] == "/scan"
    assert rows[0]["node"] == ""
    assert rows[0]["message_type"] == "sensor_msgs/msg/LaserScan"


def test_iter_rosbag2_decoded_reads_header_from_real_bag(rosbag2_bag_dir: Any) -> None:
    rows = list(iter_rosbag2_decoded(rosbag2_bag_dir))
    assert len(rows) == 2
    assert [row["timestamp"] for row in rows] == [1.0, 2.0]
    assert rows[1]["header"] == pytest.approx(2.0)
    assert rows[0]["frame_id"] == "base_link"
    assert rows[0]["node"] == "imu"
    assert rows[0]["message_type"] == "sensor_msgs/msg/Imu"


def test_iter_bag_messages_falls_back_when_reader_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bag = _make_minimal_bag(tmp_path / "minimal.db3", [1_000_000_000])

    class UnreadableBag:
        def __init__(self, *args: object, **kwargs: object) -> None:
            raise ValueError("not a readable rosbag2 database")

    monkeypatch.setattr("rosbags.highlevel.AnyReader", UnreadableBag)

    rows = list(iter_bag_messages(bag))
    assert len(rows) == 1
    assert rows[0]["topic"] == "/scan"
    assert rows[0]["node"] == ""
    assert "header" not in rows[0]


def test_real_reader_is_used_when_available(rosbag2_bag_dir: Any) -> None:
    rows = list(iter_bag_messages(rosbag2_bag_dir))
    assert rows[0]["header"] == pytest.approx(1.0)
    assert rows[0]["node"] == "imu"


def test_infer_node_heuristic_and_override() -> None:
    assert _infer_node("/imu/data", None) == "imu"
    assert _infer_node("scan", None) == "scan"
    assert _infer_node("/", None) == ""
    assert _infer_node("/imu/data", {"/imu/data": "custom_node"}) == "custom_node"
