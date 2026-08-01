from __future__ import annotations

from src.services.diagnostics import denormalize_message_stream, detect_anomalies, parse_mcap_file


DATA = [
    {"timestamp": 0.0, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"},
    {"timestamp": 0.05, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"},
    {"timestamp": 0.10, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"},
    {"timestamp": 0.15, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"},
    {"timestamp": 0.20, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"},
    {"timestamp": 0.30, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"},
    {"timestamp": 0.40, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"},
    {"timestamp": 1.0, "topic": "/odom", "node": "odom_node", "message_type": "nav_msgs/msg/Odometry"},
    {"timestamp": 1.1, "topic": "/odom", "node": "odom_node", "message_type": "nav_msgs/msg/Odometry"},
    {"timestamp": 1.2, "topic": "/odom", "node": "odom_node", "message_type": "nav_msgs/msg/Odometry"},
]


def test_denormalizer_builds_structured_array() -> None:
    array = denormalize_message_stream(DATA)
    assert array.dtype.names is not None
    assert array.shape[0] == len(DATA)
    assert set(array.dtype.names) >= {"timestamp", "topic", "node", "message_type"}


def test_rule_detector_emits_compact_detection_summary() -> None:
    summary = detect_anomalies(DATA)
    assert summary["summary"]["total_detections"] >= 1
    assert "detections" in summary
    detector_names = {item["kind"] for item in summary["detections"]}
    assert detector_names >= {"frequency_gap", "silent_node"}


def test_parse_mcap_file_supports_disk_input(tmp_path) -> None:
    bag_path = tmp_path / "synthetic.mcap"
    bag_path.write_text(
        "\n".join([
            '{"timestamp": 0.0, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"}',
            '{"timestamp": 0.05, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"}',
            '{"timestamp": 0.30, "topic": "/scan", "node": "scan_node", "message_type": "sensor_msgs/msg/LaserScan"}',
            '{"timestamp": 1.0, "topic": "/odom", "node": "odom_node", "message_type": "nav_msgs/msg/Odometry"}',
            '{"timestamp": 1.1, "topic": "/odom", "node": "odom_node", "message_type": "nav_msgs/msg/Odometry"}',
        ])
    )

    messages = parse_mcap_file(bag_path)
    assert len(messages) >= 3
    assert messages[0]["topic"] == "/scan"
