import os
import shutil
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

TEST_JWT_SECRET = "test-jwt-secret-32-chars-minimum-for-tests"
TEST_AUTH_USERNAME = "admin"
TEST_AUTH_PASSWORD = "test-pass"

# Must be set before importing the app so /health reports the test env even
# when a local .env file overrides APP_ENV.
os.environ.setdefault("APP_ENV", "test")

from src.api import routes  # noqa: E402
from src.config import get_settings  # noqa: E402
from src.main import app  # noqa: E402
from src.services import auth as auth_service  # noqa: E402
from src.services import diagnostics_config, experiments  # noqa: E402
from src.services.rate_limit import SlidingWindowRateLimiter  # noqa: E402

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "diagnostics"
DIAGNOSTICS_DATA_DIR = Path.cwd() / "data" / "diagnostics"


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    """Isolate per-test persistence, module-level caches and LLM configuration.

    Strict JWT mode (option B): every test runs with a deterministic JWT_SECRET
    so all protected endpoints require ``Authorization: Bearer <JWT>`` — tests
    reflect production behaviour. ``client`` fixture auto-injects a valid token;
    use ``unauth_client`` when you explicitly want a 401/503 check.
    """
    monkeypatch.setenv("RUN_DB_PATH", str(tmp_path / "runs.db"))
    # A developer .env holding real credentials would otherwise send analysis
    # runs to the live provider; tests that exercise the LLM stub it explicitly.
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("LLM_LANGUAGE", "vi")
    # Ensure API auth does not leak from a local .env into tests that expect open endpoints.
    monkeypatch.setenv("API_AUTH_TOKEN", "")
    # Strict JWT: enforce auth in tests (prod-like). Bypass only when a test
    # explicitly clears JWT_SECRET or stubs get_settings to empty secret.
    monkeypatch.setenv("JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setenv("AUTH_USERNAME", TEST_AUTH_USERNAME)
    monkeypatch.setenv("AUTH_PASSWORD", TEST_AUTH_PASSWORD)
    monkeypatch.setenv("AUTH_PASSWORD_HASH", "")
    # Clear JWT blacklist/users so logout/signup in one test does not affect next
    auth_service.clear_blacklist()
    auth_service.clear_users()
    # Reset rate-limit trust proxy state per test so env leakage does not affect isolation.
    monkeypatch.setattr(routes, "_TRUST_PROXY", False)
    monkeypatch.setattr(routes, "_TRUST_PROXY_HOPS", 1)
    # Isolate thresholds file so a developer's data/diagnostics/thresholds.json
    # (with pre_roll_grace_sec=8) does not swallow synthetic streams.
    monkeypatch.setenv("DIAGNOSTICS_THRESHOLDS_FILE", str(tmp_path / "thresholds.json"))
    get_settings.cache_clear()
    # Real bags warrant a multi-second warm-up grace period (see
    # diagnostics.py), but it would silently swallow the tiny synthetic
    # streams (usually starting at t=0 with the fault injected immediately)
    # nearly every diagnostics test builds. Tests that specifically exercise
    # pre-roll filtering opt back in via an explicit `thresholds` override.
    monkeypatch.setitem(diagnostics_config.DEFAULT_DIAGNOSTICS_THRESHOLDS, "pre_roll_grace_sec", 0.0)
    monkeypatch.setattr(experiments, "_cached_state", None)
    monkeypatch.setattr(experiments, "_owner_cache", {})
    monkeypatch.setattr(
        routes,
        "_rate_limiter",
        SlidingWindowRateLimiter(routes._RATE_LIMIT_MAX_REQUESTS, routes._RATE_LIMIT_WINDOW_SEC),
    )
    monkeypatch.setattr(
        routes,
        "_login_rate_limiter",
        SlidingWindowRateLimiter(routes._LOGIN_RATE_LIMIT_MAX, routes._LOGIN_RATE_LIMIT_WINDOW_SEC),
    )
    yield
    get_settings.cache_clear()
    auth_service.clear_blacklist()
    auth_service.clear_users()


def _make_auth_headers() -> dict[str, str]:
    """Build fresh Authorization header from current settings (respects monkeypatch)."""
    try:
        settings = get_settings()
        user = getattr(settings, "auth_username", TEST_AUTH_USERNAME) or TEST_AUTH_USERNAME
        token, _, _ = auth_service.create_access_token(user)
        return {"Authorization": f"Bearer {token}"}
    except Exception:
        return {}


class _AuthAsyncClient(AsyncClient):
    """AsyncClient that auto-injects a valid JWT unless caller already set Authorization."""

    async def request(self, method, url, **kwargs):  # type: ignore[override]
        headers = kwargs.get("headers")
        if headers is None:
            headers = {}
        elif not isinstance(headers, dict):
            headers = dict(headers)
        else:
            headers = dict(headers)
        has_auth = any(k.lower() == "authorization" for k in headers)
        if not has_auth:
            settings = get_settings()
            jwt_secret = getattr(settings, "jwt_secret", "")
            if jwt_secret:
                headers.update(_make_auth_headers())
        kwargs["headers"] = headers
        return await super().request(method, url, **kwargs)


@pytest_asyncio.fixture
async def client():
    """Authenticated async HTTP client (auto-injects valid JWT).

    Use ``unauth_client`` when you need to assert 401/503 without a token.
    """
    transport = ASGITransport(app=app)
    async with _AuthAsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def unauth_client():
    """Unauthenticated client — never injects Authorization (for 401/503 tests)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def diagnostics_sample_file():
    """Copy sample JSONL fixture into data/diagnostics for file-backed tests."""
    DIAGNOSTICS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    target = DIAGNOSTICS_DATA_DIR / "sample.jsonl"
    shutil.copy(FIXTURES_DIR / "sample.jsonl", target)
    yield "sample.jsonl"
    if target.exists():
        target.unlink()
