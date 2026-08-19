import os
import shutil
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Must be set before importing the app so /health reports the test env even
# when a local .env file overrides APP_ENV.
os.environ.setdefault("APP_ENV", "test")

from src.api import routes
from src.config import get_settings
from src.main import app
from src.services.rate_limit import SlidingWindowRateLimiter

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "diagnostics"
DIAGNOSTICS_DATA_DIR = Path.cwd() / "data" / "diagnostics"


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    """Isolate per-test persistence, module-level caches and LLM configuration."""
    monkeypatch.setenv("RUN_DB_PATH", str(tmp_path / "runs.db"))
    # A developer .env holding real credentials would otherwise send analysis
    # runs to the live provider; tests that exercise the LLM stub it explicitly.
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("VLLM_BASE_URL", "")
    get_settings.cache_clear()
    monkeypatch.setattr(routes, "_datasets_cache", routes._DatasetsCache(routes._DATASETS_CACHE_TTL_SEC))
    monkeypatch.setattr(
        routes,
        "_rate_limiter",
        SlidingWindowRateLimiter(routes._RATE_LIMIT_MAX_REQUESTS, routes._RATE_LIMIT_WINDOW_SEC),
    )
    yield
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def client():
    """Async HTTP client for testing API endpoints."""
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
