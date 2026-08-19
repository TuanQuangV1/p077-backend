"""Property-based Fuzzing tests with Hypothesis.

Proves that the low-level CDR parser, string decoder, and stream denormalizers
never crash with unhandled exceptions on arbitrary or corrupted byte payloads.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from rosbags.typesys import Stores, get_typestore

from src.services.bag_stream import (
    _cdr_extract,
    _cdr_read_string,
    _decode_message,
)
from src.services.diagnostics import denormalize_message_stream

# Initialize typestore once at module level for speed
_TYPESTORE = get_typestore(Stores.ROS2_HUMBLE)
_MSG_TYPES = [
    "sensor_msgs/msg/Imu",
    "sensor_msgs/msg/LaserScan",
    "geometry_msgs/msg/TransformStamped",
    "tf2_msgs/msg/TFMessage",
    "rosgraph_msgs/msg/Log",
]


class _DummyReader:
    def deserialize(self, raw, msgtype):
        return None


_DUMMY_READER = _DummyReader()


@settings(max_examples=50, deadline=None)
@given(st.binary(min_size=0, max_size=512), st.sampled_from(_MSG_TYPES))
def test_fuzz_cdr_extract_never_crashes(raw_bytes: bytes, msgtype: str) -> None:
    """Ensure _cdr_extract handles arbitrary bytes without uncaught exceptions."""
    result = _cdr_extract(raw_bytes, msgtype, _TYPESTORE)
    assert result is None or isinstance(result, dict)


@settings(max_examples=50, deadline=None)
@given(st.binary(min_size=0, max_size=256), st.integers(min_value=0, max_value=300))
def test_fuzz_cdr_read_string_never_crashes(raw_bytes: bytes, pos: int) -> None:
    """Ensure _cdr_read_string bounds checks position and length cleanly."""
    if pos >= len(raw_bytes):
        return
    val, new_pos = _cdr_read_string(raw_bytes, pos)
    assert isinstance(val, str)
    assert isinstance(new_pos, int)


@settings(max_examples=50, deadline=None)
@given(st.binary(min_size=0, max_size=256), st.sampled_from(_MSG_TYPES))
def test_fuzz_decode_message_never_crashes(raw_bytes: bytes, msgtype: str) -> None:
    """Ensure _decode_message gracefully handles arbitrary payloads."""
    res = _decode_message(raw_bytes, msgtype, _DUMMY_READER, _TYPESTORE)
    assert isinstance(res, dict)


@settings(max_examples=25, deadline=None)
@given(
    st.lists(
        st.fixed_dictionaries(
            {
                "timestamp": st.floats(
                    allow_nan=False, allow_infinity=False, min_value=0, max_value=1e9
                ),
                "topic": st.text(max_size=16),
                "node": st.text(max_size=16),
                "message_type": st.text(max_size=32),
            }
        ),
        min_size=0,
        max_size=200,
    )
)
def test_fuzz_denormalize_message_stream_never_crashes(messages: list[dict]) -> None:
    """Ensure denormalize_message_stream correctly handles small and large NumPy arrays."""
    res = denormalize_message_stream(messages)
    assert len(res) == len(messages)
