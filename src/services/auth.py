"""JWT authentication service (100% JWT, no static API_AUTH_TOKEN).

- Credentials from Settings.auth_username / auth_password / auth_password_hash
- JWT creation/verification via PyJWT (HS256)
- In-memory blacklist for logout (jti -> exp)
"""

from __future__ import annotations

import hmac
import time
import uuid
from typing import Any

import jwt
from passlib.context import CryptContext

from src.config import get_settings
import contextlib

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# jti -> exp_timestamp
_BLACKLIST: dict[str, float] = {}

# username -> password_hash (for fake signup, in-memory only)
_USERS: dict[str, str] = {}


def _cleanup_blacklist() -> None:
    now = time.time()
    expired = [jti for jti, exp in _BLACKLIST.items() if exp < now]
    for jti in expired:
        _BLACKLIST.pop(jti, None)


def _get_jwt_secret() -> str:
    secret = get_settings().jwt_secret
    if secret:
        return secret
    # Fallback for dev/test when not configured — deterministic for tests
    # Production callers should set JWT_SECRET; auth verification will handle 503
    return "dev-insecure-jwt-secret-change-me-32-chars-minimum-length"


def hash_password(password: str) -> str:
    return _pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _pwd_context.verify(plain, hashed)
    except Exception:
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
        if settings.app_env == "production":
            return False
        return False
    return hmac.compare_digest(password, expected_pass)


def verify_credentials(username: str, password: str) -> bool:
    # First check env admin
    if _verify_env_credentials(username, password):
        return True
    # Then check fake signup users
    hashed = _USERS.get(username)
    if hashed is None:
        return False
    return verify_password(password, hashed)


def register_user(username: str, password: str) -> bool:
    """Register a new fake user. Returns False if username already exists."""
    if username in _USERS:
        return False
    # Also prevent shadowing env admin username
    settings = get_settings()
    if hmac.compare_digest(username, settings.auth_username):
        return False
    _USERS[username] = hash_password(password)
    return True


def clear_users() -> None:  # for tests
    _USERS.clear()


def list_users() -> dict[str, str]:
    return dict(_USERS)


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
    _cleanup_blacklist()
    payload = jwt.decode(token, secret, algorithms=[settings.jwt_algorithm], leeway=30)
    jti = payload.get("jti")
    if jti and jti in _BLACKLIST:
        raise jwt.InvalidTokenError("token has been revoked")
    return payload


def blacklist_token(jti: str, exp: float) -> None:
    _cleanup_blacklist()
    _BLACKLIST[jti] = exp


def is_blacklisted(jti: str) -> bool:
    _cleanup_blacklist()
    return jti in _BLACKLIST


def clear_blacklist() -> None:  # for tests
    _BLACKLIST.clear()


def clear_all_auth_state() -> None:  # for tests - clear both blacklist and users
    _BLACKLIST.clear()
    _USERS.clear()
