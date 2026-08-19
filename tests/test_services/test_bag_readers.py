"""Unit tests for BaseBagReader, DB3Reader, MCAPReader and get_bag_reader factory."""

from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

import numpy as np
import pytest
from rosbags.rosbag2 import StoragePlugin, Writer
from rosbags.typesys import Stores, get_typestore

from src.services.bag_readers import (
    DB3Reader,
    MCAPReader,
    get_bag_reader,
)
from src.services.exceptions import CorruptedBagError, UnsupportedFormatError


def _create_test_db3(folder: Path, rows: list[tuple[int, int]]) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    db_path = folder / "test.db3"
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT, type TEXT)")
    conn.execute(
        "CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER, timestamp INTEGER, data BLOB)"
    )
    conn.execute("INSERT INTO topics VALUES (1, '/scan', 'sensor_msgs/msg/LaserScan')")
    conn.execute("INSERT INTO topics VALUES (2, '/imu/data', 'sensor_msgs/msg/Imu')")
    for t_ns, top_id in rows:
        conn.execute(
            "INSERT INTO messages(topic_id, timestamp, data) VALUES (?, ?, ?)",
            (top_id, t_ns, b"\x00" * 32),
        )
    conn.commit()
    conn.close()
    return db_path


def _create_test_mcap(folder: Path, stamps_ns: list[int]) -> Path:
    typestore = get_typestore(Stores.ROS2_HUMBLE)
    imu_cls = typestore.get_msgdef("sensor_msgs/msg/Imu").cls
    header_cls = typestore.get_msgdef("std_msgs/msg/Header").cls
    time_cls = typestore.get_msgdef("builtin_interfaces/msg/Time").cls
    vector_cls = typestore.get_msgdef("geometry_msgs/msg/Vector3").cls
    quat_cls = typestore.get_msgdef("geometry_msgs/msg/Quaternion").cls

    with tempfile.TemporaryDirectory() as td:
        bag_dir = Path(td) / "bag"
        with Writer(bag_dir, version=8, storage_plugin=StoragePlugin.MCAP) as writer:
            conn = writer.add_connection("/imu/data", "sensor_msgs/msg/Imu", typestore=typestore)
            for stamp_ns in stamps_ns:
                sec, nsec = divmod(stamp_ns, 1_000_000_000)
                header = header_cls(stamp=time_cls(sec=sec, nanosec=nsec), frame_id="base_link")
                imu = imu_cls(
                    header=header,
                    orientation=quat_cls(0.0, 0.0, 0.0, 1.0),
                    orientation_covariance=np.zeros(9),
                    angular_velocity=vector_cls(0.0, 0.0, 0.0),
                    angular_velocity_covariance=np.zeros(9),
                    linear_acceleration=vector_cls(0.0, 0.0, 9.8),
                    linear_acceleration_covariance=np.zeros(9),
                )
                writer.write(conn, stamp_ns, typestore.serialize_cdr(imu, conn.msgtype))
        mcap_path = next(bag_dir.rglob("*.mcap"))
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / "test.mcap"
        target.write_bytes(mcap_path.read_bytes())
    return target


def test_db3_reader_metadata_and_stream(tmp_path: Path) -> None:
    db3_path = _create_test_db3(tmp_path / "db3_test", [(1_000_000_000, 1), (2_500_000_000, 2)])
    reader = DB3Reader(db3_path)

    meta = reader.get_metadata()
    assert meta["storage_identifier"] == "sqlite3"
    assert meta["message_count"] == 2
    assert meta["duration_sec"] == 1
    assert len(meta["topics"]) == 2

    topics = reader.get_topics()
    assert any(t["name"] == "/scan" for t in topics)
    assert any(t["name"] == "/imu/data" for t in topics)

    messages = list(reader.stream_messages())
    assert len(messages) == 2
    assert messages[0]["timestamp"] == 1.0
    assert messages[1]["timestamp"] == 2.5


def test_mcap_reader_metadata_and_stream(tmp_path: Path) -> None:
    mcap_path = _create_test_mcap(
        tmp_path / "mcap_test", [1_000_000_000, 2_000_000_000, 3_000_000_000]
    )
    reader = MCAPReader(mcap_path)

    meta = reader.get_metadata()
    assert meta["storage_identifier"] == "mcap"
    assert meta["message_count"] == 3
    assert meta["duration_sec"] == 2
    assert len(meta["topics"]) >= 1
    assert meta["topics"][0]["name"] == "/imu/data"

    messages = list(reader.stream_messages())
    assert len(messages) == 3
    assert [m["timestamp"] for m in messages] == [1.0, 2.0, 3.0]
    assert messages[0]["frame_id"] == "base_link"


def test_factory_get_bag_reader_resolves_formats(tmp_path: Path) -> None:
    db3_path = _create_test_db3(tmp_path / "f_db3", [(1_000_000_000, 1)])
    mcap_path = _create_test_mcap(tmp_path / "f_mcap", [1_000_000_000])

    r1 = get_bag_reader(db3_path)
    assert isinstance(r1, DB3Reader)

    r2 = get_bag_reader(mcap_path)
    assert isinstance(r2, MCAPReader)

    r3 = get_bag_reader(tmp_path / "f_db3")
    assert isinstance(r3, DB3Reader)

    r4 = get_bag_reader(tmp_path / "f_mcap")
    assert isinstance(r4, MCAPReader)


def test_factory_rejects_missing_or_invalid_files(tmp_path: Path) -> None:
    with pytest.raises(CorruptedBagError):
        get_bag_reader(tmp_path / "non_existent.db3")

    dummy = tmp_path / "test.txt"
    dummy.write_text("hello")
    with pytest.raises(UnsupportedFormatError):
        get_bag_reader(dummy)

    empty_dir = tmp_path / "empty_dir"
    empty_dir.mkdir()
    with pytest.raises(UnsupportedFormatError):
        get_bag_reader(empty_dir)


def test_node_inference_helper(tmp_path: Path) -> None:
    db3_path = _create_test_db3(tmp_path / "node_test", [(1_000_000_000, 1)])
    reader = DB3Reader(db3_path, node_map={"/scan": "custom_lidar"})
    assert reader.infer_node("/scan") == "custom_lidar"
    assert reader.infer_node("/mobile_base/odom") == "mobile_base"
    assert reader.infer_node("/") == ""


def test_db3_reader_with_metadata_yaml(tmp_path: Path) -> None:
    folder = tmp_path / "db3_with_yaml"
    _create_test_db3(folder, [(1_000_000_000, 1)])
    yaml_file = folder / "metadata.yaml"
    yaml_file.write_text("""rosbag2_bagfile_information:
  version: 4
  storage_identifier: sqlite3
  duration:
    nanoseconds: 5000000000
  starting_time:
    nanoseconds_since_epoch: 1000000000
  message_count: 100
  topics_with_message_count:
    - topic_metadata:
        name: /scan
        type: sensor_msgs/msg/LaserScan
        serialization_format: cdr
        offered_qos_profiles: {}
      message_count: 100
""")
    reader = DB3Reader(folder)
    meta = reader.get_metadata()
    assert meta["duration_sec"] == 5
    assert meta["message_count"] == 100
    assert meta["topics"][0]["name"] == "/scan"


def test_mcap_reader_with_metadata_yaml(tmp_path: Path) -> None:
    folder = tmp_path / "mcap_with_yaml"
    _create_test_mcap(folder, [1_000_000_000])
    yaml_file = folder / "metadata.yaml"
    yaml_file.write_text("""rosbag2_bagfile_information:
  version: 4
  storage_identifier: mcap
  duration:
    nanoseconds: 2000000000
  starting_time:
    nanoseconds_since_epoch: 1000000000
  message_count: 50
  topics_with_message_count:
    - topic_metadata:
        name: /imu/data
        type: sensor_msgs/msg/Imu
        serialization_format: cdr
        offered_qos_profiles: {}
      message_count: 50
""")
    reader = MCAPReader(folder)
    meta = reader.get_metadata()
    assert meta["duration_sec"] == 2
    assert meta["message_count"] == 50
    assert meta["topics"][0]["name"] == "/imu/data"
    assert len(reader.get_topics()) == 1
