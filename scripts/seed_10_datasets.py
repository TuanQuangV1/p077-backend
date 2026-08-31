"""Generate 10 deterministic synthetic rosbag datasets for production demo."""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
from rosbags.rosbag2 import StoragePlugin, Writer
from rosbags.typesys import Stores, get_typestore

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"

SCAN_MSGTYPE = "sensor_msgs/msg/LaserScan"
ODOM_MSGTYPE = "nav_msgs/msg/Odometry"
LOG_MSGTYPE = "rcl_interfaces/msg/Log"

LOG_FATAL = 50
LOG_ERROR = 40
LOG_WARN = 30
LOG_INFO = 20


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

    def laser(sec: float, range_val: float = 1.5) -> object:
        return scan_cls(
            header=header(sec, "laser"),
            angle_min=-0.5,
            angle_max=0.5,
            angle_increment=0.002,
            time_increment=0.0,
            scan_time=0.1,
            range_min=0.1,
            range_max=50.0,
            ranges=np.array([range_val] * 501, dtype=np.float32),
            intensities=np.array([], dtype=np.float32),
        )

    def odom(sec: float, speed: float = 0.5) -> object:
        pose = pose_cls(position=point_cls(sec * speed, 0.0, 0.0), orientation=quat_cls(0.0, 0.0, 0.0, 1.0))
        twist = twist_cls(linear=vec_cls(speed, 0.0, 0.0), angular=vec_cls(0.0, 0.0, 0.0))
        return odom_cls(
            header=header(sec, "odom"),
            child_frame_id="base_link",
            pose=pose_cov_cls(pose=pose, covariance=np.zeros(36, dtype=np.float64)),
            twist=twist_cov_cls(twist=twist, covariance=np.zeros(36, dtype=np.float64)),
        )

    def log(sec: float, level: int, msg: str, name: str = "driver_node") -> object:
        s, ns = _stamp(sec)
        return log_cls(
            stamp=time_cls(sec=s, nanosec=ns),
            level=level,
            name=name,
            msg=msg,
            file="driver.cpp",
            function="check_status",
            line=128,
        )

    return {"laser": laser, "odom": odom, "log": log}


def _write_bag(typestore, target: Path, connections: list[tuple[str, str, list[tuple[int, bytes]]]]) -> None:
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


def seed_all_10() -> None:
    typestore = get_typestore(Stores.ROS2_HUMBLE)
    b = _builders(typestore)

    def s(msg, msgtype):
        return typestore.serialize_cdr(msg, msgtype)

    datasets = [
        (
            "h01_amr_delivery_nominal",
            "Robot AMR Giao hàng vận hành bình thường (100% Healthy)",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 500, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t, 0.6), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 500, 0.1)]),
            ]
        ),
        (
            "f01_lidar_frequency_drop",
            "Sự cố cảm biến Lidar /scan sụt giảm tần số nghiêm trọng (10Hz -> 2Hz)",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 150, 0.1) + _hz_stamps(15.1, 30, 0.5) + _hz_stamps(30.1, 150, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 450, 0.1)]),
            ]
        ),
        (
            "f02_odom_sensor_freeze",
            "Cảm biến Odometry /odom bị mất tín hiệu hoàn toàn 5 giây (Silent Node)",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 400, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 150, 0.1) + _hz_stamps(20.1, 200, 0.1)]),
                ("/rosout", LOG_MSGTYPE, [(int(16.0 * 1e9), s(b["log"](16.0, LOG_FATAL, "Odometry driver timeout: heartbeat lost"), LOG_MSGTYPE))]),
            ]
        ),
        (
            "f03_motor_overcurrent_fault",
            "Lỗi quá dòng động cơ Motor Driver (Liên tiếp 2 cảnh báo FATAL /rosout)",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 350, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 350, 0.1)]),
                ("/rosout", LOG_MSGTYPE, [
                    (int(10.0 * 1e9), s(b["log"](10.0, LOG_FATAL, "Motor 1 Overcurrent detected (18.4A)"), LOG_MSGTYPE)),
                    (int(10.2 * 1e9), s(b["log"](10.2, LOG_FATAL, "Emergency Stop triggered by safety controller"), LOG_MSGTYPE)),
                ]),
            ]
        ),
        (
            "h02_warehouse_patrol_normal",
            "Robot tuần tra kho hàng hoạt động ổn định (Normal Patrol)",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t, 2.0), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 450, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t, 0.4), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 450, 0.1)]),
            ]
        ),
        (
            "f04_cmd_vel_starvation",
            "Node điều hướng Planner nghẽn không xuất lệnh điều khiển /cmd_vel",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 300, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 300, 0.1)]),
                ("/rosout", LOG_MSGTYPE, [(int(8.5 * 1e9), s(b["log"](8.5, LOG_ERROR, "Planner timeout waiting for local costmap update"), LOG_MSGTYPE))]),
            ]
        ),
        (
            "f05_imu_high_jitter",
            "Độ rung lắc tín hiệu chu kỳ cao bất thường (Timestamp Jitter)",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 300, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t), ODOM_MSGTYPE)) for t in [
                    round(i * 0.1 + (0.07 if i % 2 == 0 else -0.05), 4) for i in range(300)
                ]]),
            ]
        ),
        (
            "h03_cleaning_robot_standard",
            "Robot vệ sinh công nghiệp hoạt động chu trình chuẩn",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t, 0.8), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 400, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t, 0.3), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 400, 0.1)]),
            ]
        ),
        (
            "f06_battery_low_voltage_drop",
            "Cảnh báo pin yếu và sụt áp dưới ngưỡng an toàn (Battery Critical)",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 250, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 250, 0.1)]),
                ("/rosout", LOG_MSGTYPE, [
                    (int(5.0 * 1e9), s(b["log"](5.0, LOG_WARN, "Battery level below 20% (19.8V)"), LOG_MSGTYPE)),
                    (int(12.0 * 1e9), s(b["log"](12.0, LOG_FATAL, "Battery voltage critical (18.1V) - auto-docking initiated"), LOG_MSGTYPE)),
                ]),
            ]
        ),
        (
            "h04_surveillance_drone_nominal",
            "Drone giám sát hạ tầng bay trinh sát bình thường (Drone Nominal)",
            [
                ("/scan", SCAN_MSGTYPE, [(int(t * 1e9), s(b["laser"](t, 5.0), SCAN_MSGTYPE)) for t in _hz_stamps(0.1, 350, 0.1)]),
                ("/odom", ODOM_MSGTYPE, [(int(t * 1e9), s(b["odom"](t, 1.2), ODOM_MSGTYPE)) for t in _hz_stamps(0.1, 350, 0.1)]),
            ]
        ),
    ]

    print(f"Generating {len(datasets)} rosbag datasets in {DATA_DIR}...")
    for folder_name, desc, connections in datasets:
        dest = DATA_DIR / folder_name / f"{folder_name}.mcap"
        _write_bag(typestore, dest, connections)
        size = dest.stat().st_size
        print(f"  ✅ [{folder_name}] ({size:,} bytes) - {desc}")

    print("\nAll 10 datasets generated successfully!")


if __name__ == "__main__":
    seed_all_10()
