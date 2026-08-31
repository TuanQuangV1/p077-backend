---
title: "Writing Tests"
description: "Cách viết tests cho agent và API"
weight: 1
---

## Test Structure

```
tests/
├── conftest.py           ← Fixtures dùng chung
├── test_agents/
│   └── test_graph.py     ← Test agent flow
└── test_api/
    └── test_routes.py    ← Test API endpoints
```

## Auth trong tests (Strict JWT — Option B)

Mặc định `tests/conftest.py` đặt `JWT_SECRET=test-jwt-secret-32-chars-minimum-for-tests` (prod-like) nên **mọi `/api/v1` protected đều cần JWT**. `client` tự inject JWT hợp lệ; dùng `unauth_client` khi muốn assert `401/503`.

```python
@pytest.mark.asyncio
async def test_chat_endpoint(client):
    # client đã có Authorization: Bearer <JWT> tự động
    response = await client.post("/api/v1/chat", json={"message": "Hello"})
    assert response.status_code == 200

@pytest.mark.asyncio
async def test_requires_auth(unauth_client):
    r = await unauth_client.get("/api/v1/datasets")
    assert r.status_code == 401  # thiếu JWT

@pytest.mark.asyncio
async def test_login_then_use_token(unauth_client):
    # login/signup là public, không cần JWT
    login = await unauth_client.post("/api/v1/auth/login",
        json={"username":"admin","password":"test-pass"})
    assert login.status_code == 200
    token = login.json()["access_token"]
    r = await unauth_client.get("/api/v1/datasets",
        headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
```

Để test bypass `JWT_SECRET=""` ngoài prod, stub `get_settings`:

```python
class _DevNoTokenStub:
    jwt_secret=""; app_env="development"; ...
monkeypatch.setattr("src.api.routes.get_settings", _DevNoTokenStub)
```

## API Tests (cập nhật: luôn dùng `client` đã auth)

```python
import pytest

@pytest.mark.asyncio
async def test_chat_endpoint(client):
    response = await client.post(
        "/api/v1/chat",
        json={"message": "Hello"}
    )
    assert response.status_code == 200
    data = response.json()
    assert "response" in data

@pytest.mark.asyncio
async def test_empty_message_rejected(client):
    response = await client.post(
        "/api/v1/chat",
        json={"message": ""}
    )
    assert response.status_code == 422
```

## Agent Tests

```python
@pytest.mark.asyncio
async def test_agent_returns_response():
    result = await agent.ainvoke({"query": "test query"})
    assert "response" in result
    assert len(result["response"]) > 0

@pytest.mark.asyncio
async def test_agent_handles_empty_query():
    result = await agent.ainvoke({"query": ""})
    assert "error" in result or "response" in result
```

## Fixtures (conftest.py) — Strict JWT

```python
TEST_JWT_SECRET = "test-jwt-secret-32-chars-minimum-for-tests"

@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    monkeypatch.setenv("JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setenv("AUTH_USERNAME", "admin")
    monkeypatch.setenv("AUTH_PASSWORD", "test-pass")
    ...

@pytest_asyncio.fixture
async def client():  # authenticated (auto JWT)
    transport = ASGITransport(app=app)
    async with _AuthAsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

@pytest_asyncio.fixture
async def unauth_client():  # never injects JWT — for 401/503
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
```

## Run Tests

```bash
# Run all (không cần .env, conftest tự set JWT strict)
pytest tests -v

# Specific file
pytest tests/test_api/test_routes.py -v

# With coverage (CI yêu cầu 75%)
pytest tests --cov=src --cov-report=term-missing --cov-fail-under=75

# Nếu bạn tự đặt JWT_SECRET khác trong .env, tests vẫn pass vì conftest
# monkeypatch đè lại; chỉ khi chạy prod docker compose mới cần JWT thật:
# docker compose up --build  # APP_ENV=production, yêu cầu .env có JWT_SECRET
```

## Minimum Requirements

- Tối thiểu **3 test cases** cho API
- Tối thiểu **2 test cases** cho Agent
- Tất cả tests phải pass trước khi push
