"""HILT (human-in-the-loop testing) feedback storage.

Reviewer verdicts are appended as JSONL records, one file per run, under
``data/hilt/`` (override with the ``HILT_DIR`` environment variable). Each
record carries the compact shape consumed by the HILT evaluation tooling: the
prediction text, a label (correct / wrong / partial) and an optional comment.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

HILT_LABELS = {"correct", "wrong", "partial"}
DEFAULT_HILT_DIR = Path("data/hilt")


def _hilt_dir() -> Path:
    return Path(os.environ.get("HILT_DIR", str(DEFAULT_HILT_DIR)))


def hilt_file(run_id: str) -> Path:
    """Return the JSONL feedback file for a run."""
    return _hilt_dir() / f"{run_id}.jsonl"


def append_hilt_review(run_id: str, record: dict[str, Any]) -> dict[str, Any]:
    """Append one feedback record to the run's JSONL file and return it.

    Args:
        run_id: Analysis run the record refers to.
        record: Dict with ``prediction``, ``label`` and optional ``comment``.

    Returns:
        The validated record, as persisted.

    Raises:
        ValueError: The record has an unknown label.
    """
    label = record.get("label")
    if label not in HILT_LABELS:
        raise ValueError(f"invalid hilt label: {label!r}; expected one of {sorted(HILT_LABELS)}")
    path = hilt_file(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def list_hilt_reviews(run_id: str) -> list[dict[str, Any]]:
    """Return every feedback record saved for a run, in review order.

    Returns an empty list when no feedback has been recorded yet.
    """
    path = hilt_file(run_id)
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records
