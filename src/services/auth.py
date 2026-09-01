"""JWT authentication service (100% JWT, no static API_AUTH_TOKEN).

- Credentials from Settings.auth_username / auth_password / auth_password_hash
- JWT creation/verification via PyJWT (HS256)
- Signup users and the logout blacklist are persisted in SQLite
  (``run_store``) so they survive a restart. The rate limiter is still
  in-memory, which only holds for a single instance.
"""

from __future__ import annotations

import contextlib
import hmac
import logging
import secrets
import time
import uuid
from typing import Any

import jwt
from passlib.context import CryptContext

from src.config import get_settings
from src.services import run_store

logger = logging.getLogger(__name__)

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


JWT_SECRET_MIN_LENGTH = 32

# Signing key used only when JWT_SECRET is unset, which is a dev/test-only
# state: `get_current_user` bypasses auth entirely in that case, so no token
# needs to survive a restart. Generated per process rather than hardcoded —
# the previous literal was published verbatim in .env.example, so anyone could
# mint a valid token for any deployment that copied it.
_EPHEMERAL_JWT_SECRET = secrets.token_urlsafe(48)


def _get_jwt_secret() -> str:
    secret = get_settings().jwt_secret
    if not secret:
        return _EPHEMERAL_JWT_SECRET
    if len(secret) < JWT_SECRET_MIN_LENGTH:
        raise ValueError(
            f"JWT_SECRET must be at least {JWT_SECRET_MIN_LENGTH} characters "
            f"(got {len(secret)}); generate one with: openssl rand -hex 32"
        )
    return secret


def hash_password(password: str) -> str:
    # passlib ships no type stubs, so its return type is Any.
    return str(_pwd_context.hash(password))


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bool(_pwd_context.verify(plain, hashed))
    except (ValueError, TypeError) as exc:
        # Malformed / unrecognised hash string (not a bcrypt digest). Treated as
        # a failed match; logged at debug so a corrupted stored hash is
        # traceable without leaking it.
        logger.debug("verify_password: unusable hash (%s)", type(exc).__name__)
        return False


def _verify_env_credentials(username: str, password: str) -> bool:
    """Check against single env-configured admin user."""
    settings = get_settings()
    expected_user = settings.auth_username
    if not hmac.compare_digest(username, expected_user):
        if settings.auth_password_hash:
            with contextlib.suppress(Exception):
                _pwd_context.verify(password, settings.auth_password_hash)
        return False
    if settings.auth_password_hash:
        return verify_password(password, settings.auth_password_hash)
    expected_pass = settings.auth_password
    if not expected_pass:
        # No password configured: deny in every environment. JWT needs a
        # password, and an empty one must never authenticate.
        return False
    return hmac.compare_digest(password, expected_pass)


# Bcrypt hash of a value no one can supply, used to keep the failure path's
# timing indistinguishable from the success path.
_DUMMY_HASH = _pwd_context.hash(secrets.token_urlsafe(32))


def verify_credentials(username: str, password: str) -> bool:
    # First check env admin
    if _verify_env_credentials(username, password):
        return True
    # Then check registered users. Verify against a dummy hash when the
    # username is unknown: returning early skipped bcrypt entirely, and the
    # timing difference let an attacker enumerate which usernames exist.
    record = run_store.get_auth_user(username)
    if record is None:
        verify_password(password, _DUMMY_HASH)
        return False
    return verify_password(password, record["password_hash"])


def register_user(username: str, password: str) -> bool:
    """Register a new user. Returns False if the username is taken."""
    # Prevent shadowing the env admin username.
    settings = get_settings()
    if hmac.compare_digest(username, settings.auth_username):
        return False
    return run_store.create_auth_user(username, hash_password(password))


def clear_users() -> None:  # for tests
    run_store.clear_auth_users()


def create_access_token(username: str) -> tuple[str, str, int]:
    """Create JWT for username. Returns (token, jti, expires_in_seconds)."""
    settings = get_settings()
    now = int(time.time())
    expire = now + settings.jwt_expire_minutes * 60
    jti = str(uuid.uuid4())
    payload = {
        "sub": username,
        "iat": now,
        "exp": expire,
        "jti": jti,
    }
    secret = _get_jwt_secret()
    token = jwt.encode(payload, secret, algorithm=settings.jwt_algorithm)
    expires_in = expire - now
    return token, jti, expires_in


def decode_token(token: str) -> dict[str, Any]:
    """Verify JWT and return payload. Raises jwt exceptions on failure."""
    settings = get_settings()
    secret = _get_jwt_secret()
    payload = jwt.decode(token, secret, algorithms=[settings.jwt_algorithm], leeway=30)
    jti = payload.get("jti")
    if jti and run_store.is_jti_blacklisted(str(jti)):
        raise jwt.InvalidTokenError("token has been revoked")
    return payload


def blacklist_token(jti: str, exp: float) -> None:
    run_store.blacklist_jti(jti, exp)


def is_blacklisted(jti: str) -> bool:
    return run_store.is_jti_blacklisted(jti)


def clear_blacklist() -> None:  # for tests
    run_store.clear_jwt_blacklist()
