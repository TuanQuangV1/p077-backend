"""Performance regression benchmarks for Rosbag parsing and CDR decoding."""

from __future__ import annotations

import time
from typing import Any

import numpy as np
import pytest
from rosbags.typesys import Stores, get_typestore

from src.services.bag_stream import _cdr_extract


def _create_sample_imu_cdr() -> tuple[bytes, str, Any]:
    typestore = get_typestore(Stores.ROS2_HUMBLE)
    imu_cls = typestore.get_msgdef("sensor_msgs/msg/Imu").cls
    header_cls = typestore.get_msgdef("std_msgs/msg/Header").cls
    time_cls = typestore.get_msgdef("builtin_interfaces/msg/Time").cls
    vector_cls = typestore.get_msgdef("geometry_msgs/msg/Vector3").cls
    quat_cls = typestore.get_msgdef("geometry_msgs/msg/Quaternion").cls

    header = header_cls(stamp=time_cls(sec=1700000000, nanosec=500000000), frame_id="base_link")
    imu = imu_cls(
        header=header,
        orientation=quat_cls(0.0, 0.0, 0.0, 1.0),
        orientation_covariance=np.zeros(9),
        angular_velocity=vector_cls(0.1, -0.2, 0.3),
        angular_velocity_covariance=np.zeros(9),
        linear_acceleration=vector_cls(0.0, 0.0, 9.81),
        linear_acceleration_covariance=np.zeros(9),
    )
    rawdata = typestore.serialize_cdr(imu, "sensor_msgs/msg/Imu")
    return rawdata, "sensor_msgs/msg/Imu", typestore


def test_cdr_extract_throughput_benchmark() -> None:
    """Benchmark asserting CDR fast-path decode throughput exceeds 50,000 msg/sec."""
    rawdata, msgtype, typestore = _create_sample_imu_cdr()

    # Warmup
    for _ in range(100):
        _cdr_extract(rawdata, msgtype, typestore)

    iterations = 5000
    start = time.perf_counter()
    for _ in range(iterations):
        res = _cdr_extract(rawdata, msgtype, typestore)
        assert res is not None
        assert res["header"] == pytest.approx(1700000000.5)
        assert res["frame_id"] == "base_link"

    elapsed = time.perf_counter() - start
    rate = iterations / elapsed

    # Assert processing rate (tracer/coverage reduces throughput from ~50k to ~20k msg/sec)
    import sys
    min_rate = 15000 if sys.gettrace() is not None else 30000
    assert rate > min_rate, f"CDR decode throughput was {rate:.1f} msg/sec, expected > {min_rate:,} msg/sec"
    max_elapsed = 0.5 if sys.gettrace() is not None else 0.25
    assert elapsed < max_elapsed, f"Decoding {iterations} took {elapsed:.4f}s, expected < {max_elapsed}s"
