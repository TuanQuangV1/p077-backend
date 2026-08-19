"""Unit tests for custom domain exceptions hierarchy."""

from __future__ import annotations

from pathlib import Path


from src.services.exceptions import (
    BagIndexMissingError,
    CorruptedBagError,
    DecodeError,
    RosbagParseError,
    SchemaMismatchError,
    UnsupportedFormatError,
)


def test_exception_hierarchy() -> None:
    assert issubclass(CorruptedBagError, RosbagParseError)
    assert issubclass(UnsupportedFormatError, RosbagParseError)
    assert issubclass(DecodeError, RosbagParseError)
    assert issubclass(SchemaMismatchError, RosbagParseError)
    assert issubclass(BagIndexMissingError, RosbagParseError)
    assert issubclass(RosbagParseError, RuntimeError)


def test_exception_attributes_and_string_representation() -> None:
    err = CorruptedBagError(
        "Invalid table schema",
        file_path=Path("data/bad.db3"),
        topic="/scan",
        position=1024,
        details={"code": 404},
    )
    assert err.message == "Invalid table schema"
    assert "bad.db3" in (err.file_path or "")
    assert err.topic == "/scan"
    assert err.position == 1024
    assert err.details == {"code": 404}

    as_str = str(err)
    assert "Invalid table schema" in as_str
    assert "bad.db3" in as_str
    assert "topic=/scan" in as_str
    assert "pos=1024" in as_str


def test_exception_to_dict() -> None:
    err = UnsupportedFormatError(
        "Unsupported format: .bag",
        file_path="data/legacy.bag",
    )
    d = err.to_dict()
    assert d["error_type"] == "UnsupportedFormatError"
    assert d["message"] == "Unsupported format: .bag"
    assert d["file_path"] == "data/legacy.bag"
    assert d["topic"] is None
    assert d["position"] is None
    assert d["details"] == {}
