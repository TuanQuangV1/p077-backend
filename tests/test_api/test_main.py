import pytest

from src.main import app, lifespan


@pytest.mark.asyncio
async def test_health_includes_env(client):
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["env"] == "test"


@pytest.mark.asyncio
async def test_lifespan_runs_startup_and_shutdown(capsys):
    async with lifespan(app):
        pass

    captured = capsys.readouterr()
    assert "Starting AI20K Agent" in captured.out
    assert "Shutting down..." in captured.out
