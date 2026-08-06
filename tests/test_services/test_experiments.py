"""Unit tests for experiment storage edge cases (traversal, bag path lookup)."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from src.services.experiments import delete_experiment, experiment_bag_path

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def experiments_dir(tmp_path, monkeypatch):
    monkeypatch.setattr("src.services.experiments.DATA_DIR", tmp_path)
    return tmp_path


def _make_bag(folder: Path, name: str = "bag.db3") -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(b"x")


def test_experiment_bag_path_returns_first_bag(experiments_dir) -> None:
    _make_bag(experiments_dir / "E1-1", "a.mcap")

    path = experiment_bag_path("E1-1")
    assert path is not None
    assert path.name == "a.mcap"
    assert path.parent == experiments_dir / "E1-1"


def test_experiment_bag_path_none_for_missing_dataset(experiments_dir) -> None:
    assert experiment_bag_path("missing") is None


def test_experiment_bag_path_none_for_folder_without_bags(experiments_dir) -> None:
    _make_bag(experiments_dir / "empty", "notes.txt")
    assert experiment_bag_path("empty") is None


@pytest.mark.parametrize(
    "dataset_id",
    ["", ".", "..", "a/b", "../evil", "..%2Fevil"],
)
def test_experiment_bag_path_rejects_traversal_ids(experiments_dir, dataset_id) -> None:
    assert experiment_bag_path(dataset_id) is None


def test_delete_experiment_removes_folder(experiments_dir) -> None:
    _make_bag(experiments_dir / "E9-9")
    assert delete_experiment("E9-9") is True
    assert not (experiments_dir / "E9-9").exists()


def test_delete_experiment_false_for_missing(experiments_dir) -> None:
    assert delete_experiment("missing") is False


@pytest.mark.parametrize(
    "dataset_id",
    ["", ".", "..", "a/b", "../evil", "..%2Fevil"],
)
def test_delete_experiment_rejects_traversal_ids(experiments_dir, dataset_id) -> None:
    _make_bag(experiments_dir / "evil")
    assert delete_experiment(dataset_id) is False
    assert (experiments_dir / "evil").exists()
