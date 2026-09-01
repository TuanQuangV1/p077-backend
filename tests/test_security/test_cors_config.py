"""CORS configuration hardening.

`CORS_ORIGINS="*"` with `allow_credentials=True` is not a literal wildcard in
the response — Starlette echoes the request Origin — so it still lets any site
make authenticated calls. Production must refuse it.
"""

from __future__ import annotations

import importlib

import pytest

from src.config import Settings, get_settings


def test_cors_origin_list_trims_and_drops_empties() -> None:
    settings = Settings(cors_origins=" https://a.example , ,https://b.example ")
    assert settings.cors_origin_list == ["https://a.example", "https://b.example"]


def test_production_app_refuses_wildcard_cors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("CORS_ORIGINS", "*")
    monkeypatch.setenv("JWT_SECRET", "x" * 32)
    get_settings.cache_clear()

    import src.main

    with pytest.raises(RuntimeError, match="CORS_ORIGINS"):
        importlib.reload(src.main)

    # Leave the module importable for the rest of the session.
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:3000")
    get_settings.cache_clear()
    importlib.reload(src.main)


def test_non_production_allows_wildcard_cors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("CORS_ORIGINS", "*")
    get_settings.cache_clear()

    import src.main

    importlib.reload(src.main)  # must not raise

    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:3000")
    get_settings.cache_clear()
    importlib.reload(src.main)
