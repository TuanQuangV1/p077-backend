"""Generate deterministic synthetic rosbag fixtures for the e2e test suite.

Writes four small `.mcap` bags (rosbags Writer, ROS 2 Humble typestore):

- ``scripts/e2e-fixtures/gate2/healthy_01_0.mcap`` — gate2 upload fixture:
  10 Hz ``/scan`` + 10 Hz ``/odom`` for ~180 s. No rule should fire
  -> health score 100, "System Healthy", 0 detections.
- ``scripts/e2e-fixtures/gate2/F1_02_0.mcap`` — gate2 upload fixture:
  10 Hz -> 2.5 Hz -> 10 Hz on ``/scan``, a 5 s ``/odom`` silence window and
  two FATAL logs. Fires hz_drop_critical / silent_node / log_fatal (+ jitter)
  -> health score < 70 so the LLM deep-dive badge and the "Health Score ...
  critical/high issues" summary render.
- ``data/h01/h01_0.mcap`` + ``data/f02/f02_0.mcap`` — standalone dataset
  copies (two distinct dataset ids) consumed by the dashboard / datasets /
  analysis / human-review specs; ``frontend/e2e/global-setup.ts`` runs an
  analysis for both via the API before Playwright starts.

The gate2 fixtures deliberately live OUTSIDE ``data/``: every subfolder under
``data/`` is registered as a dataset, and ``run_analysis`` chains *all* bag
files of a dataset folder into one stream — a two-bag "dataset" folder would
mask the anomaly patterns and pollute the dataset list that gate2 selects
rows from.

Idempotent: re-running overwrites the fixtures. Requires ``rosbags``
(installed via ``pip install -e .[dev]``).
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
from rosbags.highlevel import AnyReader  # noqa: PLC0415 - optional dependency
from rosbags.rosbag2 import StoragePlugin, Writer  # noqa: PLC0415
from rosbags.typesys import Stores, get_typestore

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
FIXTURE_DIR = REPO_ROOT / "scripts" / "e2e-fixtures" / "gate2"

SCAN_MSGTYPE = "sensor_msgs/msg/LaserScan"
ODOM_MSGTYPE = "nav_msgs/msg/Odometry"
LOG_MSGTYPE = "rcl_interfaces/msg/Log"

LOG_FATAL = 50

TARGETS = {
    "gate2-healthy": FIXTURE_DIR / "healthy_01_0.mcap",
    "gate2-anomaly": FIXTURE_DIR / "F1_02_0.mcap",
    "dataset-h01": DATA_DIR / "h01" / "h01_0.mcap",
    "dataset-f02": DATA_DIR / "f02" / "f02_0.mcap",
}


def _stamp(sec: float) -> tuple[int, int]:
    nanos = int(round(sec * 1_000_000_000))
    return divmod(nanos, 1_000_000_000)


def _hz_stamps(start: float, count: int, interval: float) -> list[float]:
    return [round(start + i * interval, 6) for i in range(count)]


def _builders(typestore) -> dict[str, object]:
    header_cls = typestore.get_msgdef("std_msgs/msg/Header").cls
    time_cls = typestore.get_msgdef("builtin_interfaces/msg/Time").cls
    point_cls = typestore.get_msgdef("geometry_msgs/msg/Point").cls
    quat_cls = typestore.get_msgdef("geometry_msgs/msg/Quaternion").cls
    vec_cls = typestore.get_msgdef("geometry_msgs/msg/Vector3").cls
    pose_cls = typestore.get_msgdef("geometry_msgs/msg/Pose").cls
    pose_cov_cls = typestore.get_msgdef("geometry_msgs/msg/PoseWithCovariance").cls
    twist_cls = typestore.get_msgdef("geometry_msgs/msg/Twist").cls
    twist_cov_cls = typestore.get_msgdef("geometry_msgs/msg/TwistWithCovariance").cls
    scan_cls = typestore.get_msgdef(SCAN_MSGTYPE).cls
    odom_cls = typestore.get_msgdef(ODOM_MSGTYPE).cls
    log_cls = typestore.get_msgdef(LOG_MSGTYPE).cls

    def header(sec: float, frame_id: str) -> object:
        s, ns = _stamp(sec)
        return header_cls(stamp=time_cls(sec=s, nanosec=ns), frame_id=frame_id)

    def laser(sec: float) -> object:
        return scan_cls(
            header=header(sec, "laser"),
            angle_min=-0.5,
            angle_max=0.5,
            angle_increment=0.002,
            time_increment=0.0,
            scan_time=0.1,
            range_min=0.1,
            range_max=50.0,
            ranges=np.array([0.5] * 501, dtype=np.float32),
            intensities=np.array([], dtype=np.float32),
        )

    def odom(sec: float) -> object:
        pose = pose_cls(position=point_cls(0.0, 0.0, 0.0), orientation=quat_cls(0.0, 0.0, 0.0, 1.0))
        twist = twist_cls(linear=vec_cls(0.0, 0.0, 0.0), angular=vec_cls(0.0, 0.0, 0.0))
        return odom_cls(
            header=header(sec, ""),
            child_frame_id="base_footprint",
            pose=pose_cov_cls(pose=pose, covariance=np.zeros(36, dtype=np.float64)),
            twist=twist_cov_cls(twist=twist, covariance=np.zeros(36, dtype=np.float64)),
        )

    def log_entry(sec: float, level: int, text: str) -> object:
        s, ns = _stamp(sec)
        return log_cls(
            stamp=time_cls(sec=s, nanosec=ns),
            level=level,
            name="rosout",
            msg=text,
            file="",
            function="",
            line=0,
        )

    return {"laser": laser, "odom": odom, "log": log_entry}


def build_healthy(typestore) -> list[tuple[str, str, list[tuple[int, bytes]]]]:
    b = _builders(typestore)
    scan = [(int(t * 1e9), typestore.serialize_cdr(b["laser"](t), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 1799, 0.1)]
    odom = [(int(t * 1e9), typestore.serialize_cdr(b["odom"](t), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 1799, 0.1)]
    return [
        ("/scan", SCAN_MSGTYPE, scan),
        ("/odom", ODOM_MSGTYPE, odom),
    ]


def build_faulty(typestore) -> list[tuple[str, str, list[tuple[int, bytes]]]]:
    b = _builders(typestore)
    scan_10 = _hz_stamps(0.1, 450, 0.1)
    scan_drop = _hz_stamps(45.4, 224, 0.4)
    scan_resume = _hz_stamps(134.7, 453, 0.1)
    odom_a = _hz_stamps(0.1, 600, 0.1)
    odom_b = _hz_stamps(65.1, 1148, 0.1)
    scan = [(int(t * 1e9), typestore.serialize_cdr(b["laser"](t), SCAN_MSGTYPE)) for t in scan_10 + scan_drop + scan_resume]
    odom = [(int(t * 1e9), typestore.serialize_cdr(b["odom"](t), ODOM_MSGTYPE)) for t in odom_a + odom_b]
    logs = [
        (int(70.0 * 1e9), typestore.serialize_cdr(b["log"](70.0, LOG_FATAL, "LIDAR driver crashed"), LOG_MSGTYPE)),
        (int(70.5 * 1e9), typestore.serialize_cdr(b["log"](70.5, LOG_FATAL, "LIDAR driver crashed"), LOG_MSGTYPE)),
    ]
    return [
        ("/scan", SCAN_MSGTYPE, scan),
        ("/odom", ODOM_MSGTYPE, odom),
        ("/rosout", LOG_MSGTYPE, logs),
    ]


def write_bag(typestore, target: Path, connections: list[tuple[str, str, list[tuple[int, bytes]]]]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        bag_dir = Path(td) / "bag"
        with Writer(bag_dir, version=8, storage_plugin=StoragePlugin.MCAP) as writer:
            for topic, msgtype, messages in connections:
                conn = writer.add_connection(topic, msgtype, typestore=typestore)
                for stamp_ns, raw in messages:
                    writer.write(conn, stamp_ns, raw)
        mcap_path = next(bag_dir.rglob("*.mcap"))
        target.write_bytes(mcap_path.read_bytes())


def verify_bag(target: Path, expected: dict[str, int]) -> None:
    with AnyReader([target]) as reader:
        counts: dict[str, int] = {}
        for connection, _stamp_ns, _raw in reader.messages():
            counts[connection.topic] = counts.get(connection.topic, 0) + 1
    if counts != expected:
        raise SystemExit(f"{target}: message counts {counts} != expected {expected}")


def main() -> int:
    try:
        typestore = get_typestore(Stores.ROS2_HUMBLE)
    except Exception as exc:  # pragma: no cover - environment issue
        print(f"rosbags typestore unavailable: {exc}", file=sys.stderr)
        return 1

    healthy = build_healthy(typestore)
    faulty = build_faulty(typestore)

    # Remove any leftover two-bag "dataset" folder from previous seeds: it
    # registered as a dataset whose analysis merged both bags.
    legacy_dataset = DATA_DIR / "dataset"
    if legacy_dataset.is_dir():
        shutil.rmtree(legacy_dataset)

    write_bag(typestore, TARGETS["gate2-healthy"], healthy)
    write_bag(typestore, TARGETS["gate2-anomaly"], faulty)
    write_bag(typestore, TARGETS["dataset-h01"], healthy)
    write_bag(typestore, TARGETS["dataset-f02"], faulty)

    verify_bag(TARGETS["gate2-healthy"], {"/scan": 1799, "/odom": 1799})
    verify_bag(TARGETS["gate2-anomaly"], {"/scan": 1127, "/odom": 1748, "/rosout": 2})
    verify_bag(TARGETS["dataset-h01"], {"/scan": 1799, "/odom": 1799})
    verify_bag(TARGETS["dataset-f02"], {"/scan": 1127, "/odom": 1748, "/rosout": 2})

    for target in TARGETS.values():
        print(f"seeded {target.relative_to(REPO_ROOT)} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())