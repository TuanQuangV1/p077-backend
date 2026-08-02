from __future__ import annotations

import json
from pathlib import Path
from typing import Any

DEFAULT_DIAGNOSTICS_THRESHOLDS = {
    "frequency_gap_min_threshold_sec": 0.08,
    "frequency_gap_multiplier": 1.5,
    "silent_node_min_span_sec": 0.3,
}

DEFAULT_DIAGNOSTICS_THRESHOLDS_FILE = Path("data/diagnostics/thresholds.json")


def default_diagnostics_thresholds() -> dict[str, float]:
    return dict(DEFAULT_DIAGNOSTICS_THRESHOLDS)


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
    if file_path is None:
        file_path = DEFAULT_DIAGNOSTICS_THRESHOLDS_FILE

    path = Path(file_path)
    if not path.exists():
        return default_diagnostics_thresholds()

    with path.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)

    if not isinstance(raw, dict):
        return default_diagnostics_thresholds()

    return {
        key: float(value)
        for key, value in raw.items()
        if key in DEFAULT_DIAGNOSTICS_THRESHOLDS
    }


def save_diagnostics_thresholds(
    thresholds: dict[str, Any],
    file_path: str | Path | None = None,
) -> dict[str, float]:
    path = Path(file_path) if file_path is not None else DEFAULT_DIAGNOSTICS_THRESHOLDS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    merged = merge_diagnostics_thresholds(thresholds=thresholds, file_path=path)

    with path.open("w", encoding="utf-8") as handle:
        json.dump(merged, handle, indent=2)

    return merged
