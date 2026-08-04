"""Unit tests for the HILT feedback store."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from src.services.hilt_store import append_hilt_review, list_hilt_reviews

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def hilt_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HILT_DIR", str(tmp_path))
    return tmp_path


def test_append_and_list_roundtrip(hilt_dir: Path) -> None:
    record = {"prediction": "Producer stall", "label": "partial", "comment": "IMU drop thật"}
    returned = append_hilt_review("run_1", record)
    assert returned == record

    assert list_hilt_reviews("run_1") == [record]
    lines = (hilt_dir / "run_1.jsonl").read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[0]) == record


def test_append_multiple_preserves_order(hilt_dir: Path) -> None:
    append_hilt_review("run_1", {"prediction": "a", "label": "correct", "comment": ""})
    append_hilt_review("run_1", {"prediction": "b", "label": "wrong", "comment": "nope"})
    assert [r["prediction"] for r in list_hilt_reviews("run_1")] == ["a", "b"]


def test_append_invalid_label_rejected(hilt_dir: Path) -> None:
    with pytest.raises(ValueError, match="invalid hilt label"):
        append_hilt_review("run_1", {"prediction": "x", "label": "maybe"})
    assert list_hilt_reviews("run_1") == []


def test_list_missing_file_returns_empty(hilt_dir: Path) -> None:
    assert list_hilt_reviews("ghost") == []


def test_list_skips_blank_lines(hilt_dir: Path) -> None:
    (hilt_dir / "run_1.jsonl").write_text(
        '{"prediction": "a", "label": "correct", "comment": ""}\n\n', encoding="utf-8"
    )
    assert len(list_hilt_reviews("run_1")) == 1
