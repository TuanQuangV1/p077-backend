import pytest


@pytest.mark.asyncio
async def test_health(client):
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


@pytest.mark.asyncio
async def test_chat_empty_message(client):
    response = await client.post("/api/v1/chat", json={"message": ""})
    assert response.status_code == 422  # Validation error


@pytest.mark.asyncio
async def test_agent_status(client):
    response = await client.get("/api/v1/status")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_datasets_contract(client):
    response = await client.get("/api/v1/datasets")
    assert response.status_code == 200
    data = response.json()
    assert "items" in data
    assert data["total"] >= 1
    assert data["items"][0]["name"]


@pytest.mark.asyncio
async def test_dashboard_and_analysis_contracts(client):
    overview = await client.get("/api/v1/dashboard/overview")
    assert overview.status_code == 200
    overview_json = overview.json()
    assert "totals" in overview_json
    assert "recentRuns" in overview_json

    run = await client.post("/api/v1/analysis", json={"rosbag_id": "bag_01"})
    assert run.status_code == 202
    run_json = run.json()
    assert run_json["run"]["id"]

    detail = await client.get(f"/api/v1/analysis/{run_json['run']['id']}")
    assert detail.status_code == 200
    detail_json = detail.json()
    assert detail_json["run"]["id"] == run_json["run"]["id"]


@pytest.mark.asyncio
async def test_review_contract(client):
    response = await client.get("/api/v1/review")
    assert response.status_code == 200
    data = response.json()
    assert "items" in data
    assert isinstance(data["items"], list)
