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
    "timestamp_jitter_max_sec": 0.02,
    "max_gap_burst_sec": 1.0,
    "clock_drift_max_sec": 0.1,
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

    with path.open("w", encoding="utf-8") as handle:
        json.dump(merged, handle, indent=2)

    return merged
