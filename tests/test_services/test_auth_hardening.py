"""Regressions for the auth hardening pass.

Each test here pins a specific weakness that shipped on `develop`.
"""

from __future__ import annotations

import time

import pytest

from src.config import get_settings
from src.services import auth as auth_service
from src.services.experiments import _sanitize_owner


def test_jwt_secret_is_not_a_published_constant(monkeypatch):
    """The fallback used to be a literal that .env.example shipped verbatim.

    Anyone who copied that file could mint a valid token for the deployment.
    The replacement is generated per process, so it is neither guessable nor
    shared between installs.
    """
    monkeypatch.setenv("JWT_SECRET", "")
    get_settings.cache_clear()

    secret = auth_service._get_jwt_secret()

    assert secret != "dev-insecure-jwt-secret-change-me-32-chars-minimum-length"
    assert len(secret) >= auth_service.JWT_SECRET_MIN_LENGTH


def test_short_jwt_secret_is_rejected(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "too-short")
    get_settings.cache_clear()

    with pytest.raises(ValueError, match="at least 32 characters"):
        auth_service._get_jwt_secret()


def test_unknown_username_still_runs_a_password_hash(monkeypatch):
    """Returning early for an unknown user leaked which usernames exist.

    bcrypt dominates the cost of a login, so skipping it made the "no such
    user" path measurably faster than "wrong password".
    """
    calls: list[str] = []
    real_verify = auth_service.verify_password

    def counting_verify(plain: str, hashed: str) -> bool:
        calls.append(hashed)
        return real_verify(plain, hashed)

    monkeypatch.setattr(auth_service, "verify_password", counting_verify)
    auth_service.clear_users()
    auth_service.register_user("known-user", "known-password")

    assert auth_service.verify_credentials("known-user", "wrong-password") is False
    hashed_known = len(calls)

    calls.clear()
    assert auth_service.verify_credentials("no-such-user", "wrong-password") is False
    hashed_unknown = len(calls)

    assert hashed_unknown == hashed_known


def test_empty_configured_password_never_authenticates(monkeypatch):
    monkeypatch.setenv("AUTH_USERNAME", "admin")
    monkeypatch.setenv("AUTH_PASSWORD", "")
    monkeypatch.setenv("AUTH_PASSWORD_HASH", "")
    monkeypatch.setenv("APP_ENV", "development")
    get_settings.cache_clear()
    auth_service.clear_users()

    assert auth_service.verify_credentials("admin", "") is False
    assert auth_service.verify_credentials("admin", "anything") is False


@pytest.mark.parametrize(
    "left,right",
    [
        ("a-b", "a--b"),
        ("a-b", "a b"),
        ("admin", ".."),
    ],
)
def test_distinct_usernames_never_share_a_dataset_folder(left, right):
    """Sanitising collapsed several names onto one directory.

    `a-b`, `a--b` and `a b` all became `a-b`, and `..` became `admin` — so one
    user could read and delete another's datasets.
    """
    assert _sanitize_owner(left) != _sanitize_owner(right)


@pytest.mark.parametrize("owner", ["admin", "bob", "a-b", "user.name", "a_b"])
def test_already_safe_usernames_keep_their_folder(owner):
    """Existing installs must not lose track of directories already on disk."""
    assert _sanitize_owner(owner) == owner


def test_signup_user_survives_a_restart():
    """Users were a module-level dict, so every signup vanished on restart.

    `run_store` reads the SQLite file per call, so re-importing it (the closest
    a test gets to a fresh process) still finds the account.
    """
    import importlib

    from src.services import run_store

    auth_service.register_user("persisted-user", "s3cret-pw")
    run_store_reloaded = importlib.reload(run_store)
    assert run_store_reloaded.get_auth_user("persisted-user") is not None
    assert auth_service.verify_credentials("persisted-user", "s3cret-pw") is True
    assert auth_service.verify_credentials("persisted-user", "wrong") is False


def test_revoked_token_stays_revoked_after_restart():
    """The logout blacklist was in-memory, so a restart un-revoked every token."""
    import importlib

    from src.services import run_store

    _token, jti, _ = auth_service.create_access_token("admin")
    auth_service.blacklist_token(jti, time.time() + 3600)
    importlib.reload(run_store)
    assert auth_service.is_blacklisted(jti) is True


def test_expired_blacklist_entry_is_not_treated_as_revoked():
    _token, jti, _ = auth_service.create_access_token("admin")
    auth_service.blacklist_token(jti, time.time() - 1)
    assert auth_service.is_blacklisted(jti) is False
