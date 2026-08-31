"""Persistence and merging of diagnostics detection thresholds.

The thresholds file location defaults to ``data/diagnostics/thresholds.json``
and can be overridden with the ``DIAGNOSTICS_THRESHOLDS_FILE`` environment
variable or by passing ``file_path`` explicitly.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_DIAGNOSTICS_THRESHOLDS = {
    "frequency_gap_min_threshold_sec": 0.08,
    "frequency_gap_multiplier": 1.5,
    "silent_node_min_span_sec": 0.3,
    "silent_node_gap_multiplier": 5.0,
    "silent_node_critical_sec": 20.0,
    "timestamp_jitter_max_sec": 0.02,
    "max_gap_burst_sec": 1.0,
    "clock_drift_max_sec": 0.1,
    "clock_drift_min_count": 3,
    "clock_drift_ramp_critical_rate_ms_per_sec": 40.0,
    "clock_drift_min_span_sec": 0.5,
    "clock_drift_max_rate_ms_per_sec": 500.0,
    "hz_drop_warn_pct": 0.30,
    "hz_drop_critical_pct": 0.50,
    "hz_drop_min_messages": 50,
    "header_latency_max_ms": 100,
    "log_error_min_count": 3,
    "log_warn_min_count": 10,
    "log_fatal_min_count": 1,
    "tf_max_missing_span_sec": 0.5,
    "tf_missing_gap_critical_sec": 15.0,
    "tf_jump_distance_m": 0.5,
    "payload_zero_byte_min_count": 5,
    "payload_nan_ratio_min": 0.05,
    "payload_nan_min_count": 5,
    "payload_out_of_range_ratio_min": 0.05,
    "payload_out_of_range_min_count": 5,
    "frequency_gap_high_occurrence_min": 10,
    "pre_roll_grace_sec": 8.0,
    "tf_conflict_window_sec": 2.0,
    "tf_conflict_min_jumps": 3,
}

DEFAULT_DIAGNOSTICS_THRESHOLDS_FILE = Path("data/diagnostics/thresholds.json")


def default_diagnostics_thresholds() -> dict[str, float]:
    return dict(DEFAULT_DIAGNOSTICS_THRESHOLDS)


def _resolve_thresholds_path(file_path: str | Path | None) -> Path:
    if file_path is not None:
        return Path(file_path)
    return Path(os.environ.get("DIAGNOSTICS_THRESHOLDS_FILE", str(DEFAULT_DIAGNOSTICS_THRESHOLDS_FILE)))


def merge_diagnostics_thresholds(
    thresholds: dict[str, Any] | None = None,
    file_path: str | Path | None = None,
) -> dict[str, float]:
    merged = default_diagnostics_thresholds()
    persisted = get_diagnostics_thresholds(file_path=file_path)
    merged.update({k: float(v) for k, v in persisted.items() if k in merged})

    if thresholds:
        merged.update({k: float(v) for k, v in thresholds.items() if k in merged})

    return merged


def get_diagnostics_thresholds(file_path: str | Path | None = None) -> dict[str, float]:
    path = _resolve_thresholds_path(file_path)

    if not path.exists():
        return default_diagnostics_thresholds()

    try:
        with path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (json.JSONDecodeError, OSError):
        logger.warning(
            "diagnostics.thresholds.unreadable",
            extra={
                "diagnostics": {
                    "event": "diagnostics.thresholds.unreadable",
                    "level": "warning",
                    "details": {"path": str(path)},
                }
            },
        )
        return default_diagnostics_thresholds()

    if not isinstance(raw, dict):
        return default_diagnostics_thresholds()

    return {key: float(value) for key, value in raw.items() if key in DEFAULT_DIAGNOSTICS_THRESHOLDS}


def save_diagnostics_thresholds(
    thresholds: dict[str, Any],
    file_path: str | Path | None = None,
) -> dict[str, float]:
    path = _resolve_thresholds_path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    merged = merge_diagnostics_thresholds(thresholds=thresholds, file_path=path)

    # Persist only the delta from the code-level defaults, not the full
    # resolved set. Writing every key (even ones nobody touched) pins them on
    # disk permanently — a value baked in at save time silently overrides any
    # future change to `DEFAULT_DIAGNOSTICS_THRESHOLDS` in code, including a
    # test's own monkeypatch of it (see `tests/conftest.py::_isolate_state`,
    # which zeroes `pre_roll_grace_sec` for tests — moot if the file on disk
    # still says 8.0). An unmodified key stays absent, so it always tracks
    # whatever the code default is.
    defaults = default_diagnostics_thresholds()
    delta = {key: value for key, value in merged.items() if value != defaults.get(key)}

    with path.open("w", encoding="utf-8") as handle:
        json.dump(delta, handle, indent=2)

    return merged
