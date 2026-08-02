import os
import shutil
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Must be set before importing the app so /health reports the test env even
# when a local .env file overrides APP_ENV.
os.environ.setdefault("APP_ENV", "test")

from src.main import app

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "diagnostics"
DIAGNOSTICS_DATA_DIR = Path.cwd() / "data" / "diagnostics"


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


@pytest.fixture
def mock_llm():
    """Mock LLM to avoid calling OpenAI during tests."""
    mock = AsyncMock()
    mock.ainvoke.return_value = AsyncMock(content="Mocked LLM response")
    return mock
