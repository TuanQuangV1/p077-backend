"""Unit tests for experiment storage edge cases (traversal, bag path lookup)."""

from __future__ import annotations

import io
import logging
import sqlite3
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import pytest
from rosbags.rosbag2 import StoragePlugin, Writer
from rosbags.typesys import Stores, get_typestore

from src.services.experiments import (
    _extract_zip_safely,
    _load_item,
    delete_experiment,
    experiment_bag_path,
    save_uploaded_rosbag,
)


@pytest.fixture
def experiments_dir(tmp_path, monkeypatch):
    monkeypatch.setattr("src.services.experiments.DATA_DIR", tmp_path)
    return tmp_path


def _make_bag(folder: Path, name: str = "bag.db3") -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(b"x")


def _write_mcap(folder: Path, stamps_ns: list[int]) -> Path:
    """Write a real `.mcap` file with IMU messages and return its path.

    `folder` is created if needed and contains only the bag file (no
    `metadata.yaml`), mirroring a direct `.mcap` upload.
    """
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
        target = folder / "bag.mcap"
        target.write_bytes(mcap_path.read_bytes())
    return target


def test_experiment_bag_path_returns_first_bag(experiments_dir) -> None:
    _make_bag(experiments_dir / "E1-1", "a.mcap")

    path = experiment_bag_path("E1-1")
    assert path is not None
    assert path.name == "a.mcap"
    assert path.parent == experiments_dir / "E1-1"


def test_experiment_bag_path_none_for_missing_dataset(experiments_dir) -> None:
    assert experiment_bag_path("missing") is None


def test_experiment_bag_path_none_for_folder_without_bags(experiments_dir) -> None:
    _make_bag(experiments_dir / "empty", "notes.txt")
    assert experiment_bag_path("empty") is None


@pytest.mark.parametrize(
    "dataset_id",
    ["", ".", "..", "a/b", "../evil", "..%2Fevil"],
)
def test_experiment_bag_path_rejects_traversal_ids(experiments_dir, dataset_id) -> None:
    assert experiment_bag_path(dataset_id) is None


def test_delete_experiment_removes_folder(experiments_dir) -> None:
    _make_bag(experiments_dir / "E9-9")
    assert delete_experiment("E9-9") is True
    assert not (experiments_dir / "E9-9").exists()


def test_delete_experiment_false_for_missing(experiments_dir) -> None:
    assert delete_experiment("missing") is False


@pytest.mark.parametrize(
    "dataset_id",
    ["", ".", "..", "a/b", "../evil", "..%2Fevil"],
)
def test_delete_experiment_rejects_traversal_ids(experiments_dir, dataset_id) -> None:
    _make_bag(experiments_dir / "evil")
    assert delete_experiment(dataset_id) is False
    assert (experiments_dir / "evil").exists()


def _make_lying_zip(data: bytes) -> bytes:
    """Build a zip whose member announces a tiny uncompressed size while its
    decompressed content is `data` bytes (a header-lie zip bomb)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("bomb.bin", data)
    raw = bytearray(buf.getvalue())
    offset = 0
    while offset + 4 <= len(raw):
        sig = int.from_bytes(raw[offset : offset + 4], "little")
        if sig == 0x04034B50:  # local file header
            raw[offset + 22 : offset + 26] = (5).to_bytes(4, "little")
            name_len = int.from_bytes(raw[offset + 26 : offset + 28], "little")
            extra_len = int.from_bytes(raw[offset + 28 : offset + 30], "little")
            offset += 30 + name_len + extra_len
        elif sig == 0x02014B50:  # central directory header
            raw[offset + 24 : offset + 28] = (5).to_bytes(4, "little")
            name_len = int.from_bytes(raw[offset + 28 : offset + 30], "little")
            extra_len = int.from_bytes(raw[offset + 30 : offset + 32], "little")
            comment_len = int.from_bytes(raw[offset + 32 : offset + 34], "little")
            offset += 46 + name_len + extra_len + comment_len
        elif sig == 0x06054B50:  # end of central directory
            break
        else:
            break
    return bytes(raw)


def _make_valid_db3(bytes_io: io.BytesIO) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "bag.db3"
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT, type TEXT)")
        conn.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER, timestamp INTEGER, data BLOB)")
        conn.execute("INSERT INTO topics VALUES (1, '/scan', 'sensor_msgs/msg/LaserScan')")
        conn.execute(
            "INSERT INTO messages(topic_id, timestamp) VALUES (1, 1000000000)"
        )
        conn.commit()
        conn.close()
        bytes_io.write(path.read_bytes())
    bytes_io.seek(0)


def test_upload_creates_timestamp_index(experiments_dir) -> None:
    payload = io.BytesIO()
    _make_valid_db3(payload)

    item = save_uploaded_rosbag("trip_01.db3", payload)

    stored = experiments_dir / item["id"] / "trip_01.db3"
    conn = sqlite3.connect(stored)
    try:
        indexes = {
            row[1] for row in conn.execute("SELECT * FROM sqlite_master WHERE type='index'")
        }
    finally:
        conn.close()
    assert "idx_messages_topic_time" in indexes
    assert "idx_messages_time" in indexes


def test_upload_index_failure_does_not_block_upload(experiments_dir, caplog) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "bad.db3"
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT, type TEXT)")
        conn.commit()
        conn.close()
        payload = io.BytesIO(path.read_bytes())

    with caplog.at_level(logging.WARNING, logger="src.services.experiments"):
        item = save_uploaded_rosbag("broken_bag.db3", payload)

    assert item["status"] == "uploaded"
    assert "experiments.index_skip" in caplog.text


def test_datasets_derived_from_mcap_without_metadata(experiments_dir) -> None:
    folder = experiments_dir / "mcap-run"
    _write_mcap(folder, stamps_ns=[1_000_000_000, 2_000_000_000])
    assert not (folder / "metadata.yaml").exists()

    item = _load_item(folder)

    assert item is not None
    assert item["id"] == "mcap-run"
    assert item["messageCount"] == 2
    assert item["durationSec"] == 1
    assert item["topics"][0]["name"] == "/imu/data"
    assert item["topics"][0]["type"] == "sensor_msgs/msg/Imu"


def test_upload_flat_mcap_skips_metadata_fabrication(experiments_dir) -> None:
    with tempfile.TemporaryDirectory() as td:
        mcap = _write_mcap(Path(td) / "src", stamps_ns=[1_000_000_000, 2_000_000_000])
        payload = io.BytesIO(mcap.read_bytes())

    item = save_uploaded_rosbag("bag.mcap", payload)

    assert item["status"] == "uploaded"
    assert item["messageCount"] == 2
    stored = experiments_dir / item["id"] / "bag.mcap"
    assert stored.exists()
    assert not (experiments_dir / item["id"] / "metadata.yaml").exists()


class _FailingReader(io.BytesIO):
    """BinaryIO that raises mid-stream to simulate a broken upload source."""

    fail_after = 0
    _reads = 0

    def read(self, size: int = -1) -> bytes:
        self._reads += 1
        if self._reads > self.fail_after:
            raise OSError("simulated read failure")
        return super().read(size)


def test_upload_failure_mid_copy_cleans_folder(experiments_dir) -> None:
    payload = _FailingReader(b"x" * 4096)
    payload.fail_after = 1

    with pytest.raises(OSError, match="simulated read failure"):
        save_uploaded_rosbag("doomed.db3", payload)

    assert list(experiments_dir.iterdir()) == []


def test_upload_zip_extract_failure_cleans_folder(experiments_dir, monkeypatch) -> None:
    # A zip that passes the header-size sum but fails while extracting: the
    # member's compressed payload is truncated so reading it raises.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("bag/metadata.yaml", "rosbag2_bagfile_information:\n  version: 4\n")
    raw = bytearray(buf.getvalue())
    # Chop the end-of-central-directory record off so opening the zip fails.
    del raw[-22:]
    monkeypatch.setattr("src.services.experiments.MAX_UPLOAD_BYTES", 1024)

    with pytest.raises(zipfile.BadZipFile):
        save_uploaded_rosbag("doomed.zip", io.BytesIO(bytes(raw)))

    assert list(experiments_dir.iterdir()) == []


def test_extract_zip_safe_blocks_true_expansion_bomb(experiments_dir, monkeypatch) -> None:
    monkeypatch.setattr("src.services.experiments.MAX_UPLOAD_BYTES", 10)
    archive = experiments_dir / "bomb.zip"
    archive.write_bytes(_make_lying_zip(b"x" * 20480))
    target = experiments_dir / "target"

    with pytest.raises(ValueError, match="zip uncompressed size exceeds upload size limit"):
        _extract_zip_safely(archive, target)

    extracted = list(target.rglob("*")) if target.exists() else []
    assert len(extracted) == 0


def test_extract_zip_safe_accepts_within_limit(experiments_dir) -> None:
    archive = experiments_dir / "ok.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("bag/meta.yaml", "version: 4")
    target = experiments_dir / "target"

    _extract_zip_safely(archive, target)

    assert (target / "bag" / "meta.yaml").exists()
