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


def test_iter_rosbag2_messages_returns_sorted_without_sql_order_by(tmp_path: Path) -> None:
    bag_path = _make_minimal_bag(
        tmp_path / "unsorted.db3", [3_000_000_000, 1_000_000_000, 2_000_000_000]
    )
    rows = list(iter_rosbag2_messages(bag_path))
    assert [row["timestamp"] for row in rows] == [1.0, 2.0, 3.0]
    assert all(row["topic"] == "/scan" for row in rows)
    assert all(row["node"] == "" for row in rows)
    assert all(row["message_type"] == "sensor_msgs/msg/LaserScan" for row in rows)


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


def test_iter_bag_messages_mcap_raises_clear_error_when_decode_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mcap = tmp_path / "bag.mcap"
    mcap.write_bytes(b"not a real mcap")

    class UnreadableBag:
        def __init__(self, *args: object, **kwargs: object) -> None:
            raise ValueError("decode exploded")

    monkeypatch.setattr("rosbags.highlevel.AnyReader", UnreadableBag)

    with pytest.raises(RuntimeError) as excinfo:
        list(iter_bag_messages(mcap))

    message = str(excinfo.value)
    assert "rosbags" in message
    assert ".mcap" in message
    assert "decode failed" in message
    assert "not a readable rosbag2 database" in message
    assert not isinstance(excinfo.value, sqlite3.DatabaseError)


def test_iter_bag_messages_db3_still_falls_back_normally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bag = _make_minimal_bag(tmp_path / "minimal.db3", [2_000_000_000, 1_000_000_000])

    class UnreadableBag:
        def __init__(self, *args: object, **kwargs: object) -> None:
            raise ValueError("not a readable rosbag2 database")

    monkeypatch.setattr("rosbags.highlevel.AnyReader", UnreadableBag)

    rows = list(iter_bag_messages(bag))
    assert [row["timestamp"] for row in rows] == [1.0, 2.0]
    assert rows[0]["topic"] == "/scan"
    assert rows[0]["node"] == ""
    assert "header" not in rows[0]


def test_real_reader_is_used_when_available(rosbag2_bag_dir: Any) -> None:
    rows = list(iter_bag_messages(rosbag2_bag_dir))
    assert rows[0]["header"] == pytest.approx(1.0)
    assert rows[0]["node"] == "imu"


def test_iter_rosbag2_decoded_reads_every_tf_edge_and_scan_nan_ratio(tmp_path: Path) -> None:
    """A batched /tf publish and a corrupted LaserScan must decode fully.

    Real /tf messages batch several independent edges in one publish (map->odom,
    odom->base_footprint, wheel joints, ...); the decoded row must expose every
    edge (not just the first) so per-edge gap detection can see all of them.
    LaserScan.ranges is never retained, only the fraction that decoded as NaN.
    """
    typestore = get_typestore(Stores.ROS2_HUMBLE)
    tf_msg_cls = typestore.get_msgdef("tf2_msgs/msg/TFMessage").cls
    transform_stamped_cls = typestore.get_msgdef("geometry_msgs/msg/TransformStamped").cls
    transform_cls = typestore.get_msgdef("geometry_msgs/msg/Transform").cls
    vector_cls = typestore.get_msgdef("geometry_msgs/msg/Vector3").cls
    quat_cls = typestore.get_msgdef("geometry_msgs/msg/Quaternion").cls
    header_cls = typestore.get_msgdef("std_msgs/msg/Header").cls
    time_cls = typestore.get_msgdef("builtin_interfaces/msg/Time").cls
    scan_cls = typestore.get_msgdef("sensor_msgs/msg/LaserScan").cls

    def _transform(frame_id: str, child_frame_id: str) -> Any:
        return transform_stamped_cls(
            header=header_cls(stamp=time_cls(sec=0, nanosec=0), frame_id=frame_id),
            child_frame_id=child_frame_id,
            transform=transform_cls(
                translation=vector_cls(0.0, 0.0, 0.0),
                rotation=quat_cls(0.0, 0.0, 0.0, 1.0),
            ),
        )

    bag_dir = tmp_path / "bag"
    with Writer(bag_dir, version=9) as writer:
        tf_conn = writer.add_connection("/tf", "tf2_msgs/msg/TFMessage", typestore=typestore)
        tf_msg = tf_msg_cls(
            transforms=[
                _transform("map", "odom"),
                _transform("odom", "base_footprint"),
            ]
        )
        writer.write(tf_conn, 0, typestore.serialize_cdr(tf_msg, tf_conn.msgtype))

        scan_conn = writer.add_connection("/scan", "sensor_msgs/msg/LaserScan", typestore=typestore)
        ranges = np.array([1.0, float("nan"), float("nan"), 2.0], dtype=np.float32)
        scan = scan_cls(
            header=header_cls(stamp=time_cls(sec=0, nanosec=0), frame_id="laser"),
            angle_min=0.0,
            angle_max=0.0,
            angle_increment=0.0,
            time_increment=0.0,
            scan_time=0.0,
            range_min=0.0,
            range_max=10.0,
            ranges=ranges,
            intensities=np.zeros(4, dtype=np.float32),
        )
        writer.write(scan_conn, 0, typestore.serialize_cdr(scan, scan_conn.msgtype))

    rows = {row["topic"]: row for row in iter_rosbag2_decoded(bag_dir)}

    tf_row = rows["/tf"]
    assert tf_row["transforms"] == [
        {"frame_id": "map", "child_frame_id": "odom"},
        {"frame_id": "odom", "child_frame_id": "base_footprint"},
    ]
    assert tf_row["nan_ratio"] is None

    scan_row = rows["/scan"]
    assert scan_row["nan_ratio"] == pytest.approx(0.5)
    assert scan_row["transforms"] == []


def test_infer_node_heuristic_and_override() -> None:
    assert _infer_node("/imu/data", None) == "imu"
    assert _infer_node("scan", None) == "scan"
    assert _infer_node("/", None) == ""
    assert _infer_node("/imu/data", {"/imu/data": "custom_node"}) == "custom_node"
