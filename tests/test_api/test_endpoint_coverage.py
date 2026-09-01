"""Functional coverage for endpoints the audit flagged as untested.

`GET /analysis/{id}/health`, `GET /analysis/{id}/deep-dive`, `GET /review/stats`,
`GET /hilt/summary/{id}`, `POST /hilt/iterate`, `POST /hilt/fix/{id}` plus the
JWT error paths (expired / bad signature / revoked).
"""

from __future__ import annotations

import time

import jwt
import pytest

from src.services import auth as auth_service
from src.services import run_store
from tests.conftest import TEST_JWT_SECRET
from tests.test_api.test_routes import _write_dataset

# A dataset whose 2.0s hole between t=1.2s and t=3.2s trips silent_node/gap
# rules — the same shape the existing analysis tests use.
_FAULTY_STAMPS = [1_000_000_000, 1_100_000_000, 1_200_000_000, 3_200_000_000, 3_300_000_000]


@pytest.fixture
def experiments_dir(tmp_path, monkeypatch):
    """Point dataset storage at a temp dir (mirrors the test_routes fixture)."""
    monkeypatch.setattr("src.services.experiments.DATA_DIR", tmp_path)
    return tmp_path


async def _run_with_anomaly(client, experiments_dir) -> tuple[str, str]:
    """Create a dataset, analyse it, return (run_id, first anomaly_id)."""
    _write_dataset(experiments_dir / "E1-1", stamps_ns=_FAULTY_STAMPS)
    run = await client.post("/api/v1/analysis", json={"rosbag_id": "E1-1"})
    assert run.status_code == 202
    run_id = run.json()["run"]["id"]
    detail = await client.get(f"/api/v1/analysis/{run_id}")
    anomaly_id = detail.json()["anomalies"][0]["id"]
    return run_id, anomaly_id


# --- GET /analysis/{id}/health --------------------------------------------


@pytest.mark.asyncio
async def test_analysis_health_returns_summary(client, experiments_dir):
    run_id, _ = await _run_with_anomaly(client, experiments_dir)

    response = await client.get(f"/api/v1/analysis/{run_id}/health")

    assert response.status_code == 200
    health = response.json()["health"]
    assert 0 <= health["health_score"] <= 100
    assert health["status"] in {"green", "yellow", "red"}
    assert "groups" in health["summary"]
    assert isinstance(health["trigger_llm_deep_dive"], bool)


@pytest.mark.asyncio
async def test_analysis_health_unknown_run_is_404(client):
    response = await client.get("/api/v1/analysis/does-not-exist/health")
    assert response.status_code == 404


# --- GET /analysis/{id}/deep-dive ----------------------------------------


@pytest.mark.asyncio
async def test_analysis_deep_dive_returns_context_and_prompt(client, experiments_dir):
    run_id, _ = await _run_with_anomaly(client, experiments_dir)

    response = await client.get(f"/api/v1/analysis/{run_id}/deep-dive")

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id
    assert isinstance(body["triggered"], bool)
    assert isinstance(body["prompt"], str) and body["prompt"]
    assert "health_score" in body["health"]


@pytest.mark.asyncio
async def test_analysis_deep_dive_unknown_run_is_404(client):
    response = await client.get("/api/v1/analysis/nope/deep-dive")
    assert response.status_code == 404


# --- GET /review/stats --------------------------------------------------


@pytest.mark.asyncio
async def test_review_stats_empty_when_no_verdicts(client):
    response = await client.get("/api/v1/review/stats")
    assert response.status_code == 200
    body = response.json()
    assert body["runs"] == []
    assert body["reviewed"] == 0
    assert body["accuracy"] is None


@pytest.mark.asyncio
async def test_review_stats_aggregates_decided_items(client, experiments_dir):
    run_id, _ = await _run_with_anomaly(client, experiments_dir)
    queue = await client.get("/api/v1/review")
    pending = [i for i in queue.json()["items"] if i["runId"] == run_id]
    assert pending
    # The LLM did not run for this synthetic bag, so the conclusions are
    # rule-based fallbacks — approving one is blocked, rejecting is fine.
    assert (
        await client.post(f"/api/v1/review/{pending[0]['id']}/decision", json={"verdict": "rejected"})
    ).status_code == 200

    response = await client.get("/api/v1/review/stats")

    assert response.status_code == 200
    body = response.json()
    assert body["rejected"] == 1
    assert body["reviewed"] == 1
    assert body["accuracy"] == 0.0
    assert any(run["runId"] == run_id and run["rejected"] == 1 for run in body["runs"])


# --- GET /hilt/summary/{id} -------------------------------------------------


@pytest.mark.asyncio
async def test_hilt_summary_returns_iteration_history(client, experiments_dir):
    run_id, anomaly_id = await _run_with_anomaly(client, experiments_dir)

    response = await client.get(
        f"/api/v1/hilt/summary/{run_id}", params={"anomaly_id": anomaly_id}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id
    assert body["anomaly_id"] == anomaly_id
    assert isinstance(body["iterations"], list)
    assert isinstance(body["trigger_reasons"], list)


@pytest.mark.asyncio
async def test_hilt_summary_unknown_run_is_404(client):
    response = await client.get("/api/v1/hilt/summary/nope", params={"anomaly_id": "a1"})
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_hilt_summary_unknown_anomaly_is_404(client, experiments_dir):
    run_id, _ = await _run_with_anomaly(client, experiments_dir)
    response = await client.get(
        f"/api/v1/hilt/summary/{run_id}", params={"anomaly_id": "no-such-anomaly"}
    )
    assert response.status_code == 404


# --- POST /hilt/iterate ---------------------------------------------------


@pytest.mark.asyncio
async def test_hilt_iterate_records_and_returns_suggestion(client, experiments_dir):
    run_id, anomaly_id = await _run_with_anomaly(client, experiments_dir)

    response = await client.post(
        "/api/v1/hilt/iterate",
        params={
            "run_id": run_id,
            "anomaly_id": anomaly_id,
            "test_pass": False,
            "test_comment": "still stalling after driver restart",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["anomalyId"] == anomaly_id
    assert body["rootCause"]

    stored = run_store.list_hilt_iterations(run_id, anomaly_id)
    assert len(stored) == 1
    assert stored[0]["test_pass"] == 0
    assert stored[0]["test_comment"] == "still stalling after driver restart"


@pytest.mark.asyncio
async def test_hilt_iterate_missing_required_params_is_422(client):
    response = await client.post("/api/v1/hilt/iterate", params={"run_id": "r1"})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_hilt_iterate_unknown_run_is_404(client):
    response = await client.post(
        "/api/v1/hilt/iterate",
        params={"run_id": "nope", "anomaly_id": "a1", "test_pass": True},
    )
    assert response.status_code == 404


# --- POST /hilt/fix/{id} -------------------------------------------------


@pytest.mark.asyncio
async def test_hilt_fix_persists_expert_correction(client, experiments_dir):
    run_id, anomaly_id = await _run_with_anomaly(client, experiments_dir)

    response = await client.post(
        f"/api/v1/hilt/fix/{run_id}",
        params={"anomaly_id": anomaly_id},
        json={
            "corrected_root_cause": "LiDAR USB hub brown-out under load",
            "corrected_actions": ["swap to powered hub", "add UPS on the sensor rail"],
            "notes": "confirmed on the bench",
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True

    fix = run_store.get_expert_fix(run_id, anomaly_id)
    assert fix is not None
    assert fix["root_cause"] == "LiDAR USB hub brown-out under load"
    assert fix["actions"] == ["swap to powered hub", "add UPS on the sensor rail"]


@pytest.mark.asyncio
async def test_hilt_fix_unknown_run_is_404(client):
    response = await client.post(
        "/api/v1/hilt/fix/nope",
        params={"anomaly_id": "a1"},
        json={"corrected_root_cause": "x", "corrected_actions": [], "notes": None},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_hilt_fix_unknown_anomaly_is_404(client, experiments_dir):
    run_id, _ = await _run_with_anomaly(client, experiments_dir)
    response = await client.post(
        f"/api/v1/hilt/fix/{run_id}",
        params={"anomaly_id": "no-such-anomaly"},
        json={"corrected_root_cause": "x", "corrected_actions": [], "notes": None},
    )
    assert response.status_code == 404


# --- JWT error paths ----------------------------------------------------


def _token(sub: str = "admin", *, exp_delta: int = 3600, secret: str = TEST_JWT_SECRET) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iat": now, "exp": now + exp_delta, "jti": f"jti-{now}-{exp_delta}"},
        secret,
        algorithm="HS256",
    )


@pytest.mark.asyncio
async def test_expired_jwt_is_rejected(unauth_client):
    # decode_token allows 30s leeway, so the token must be well past expiry.
    response = await unauth_client.get(
        "/api/v1/runs", headers={"Authorization": f"Bearer {_token(exp_delta=-120)}"}
    )
    assert response.status_code == 401
    assert "expired" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_jwt_signed_with_wrong_secret_is_rejected(unauth_client):
    response = await unauth_client.get(
        "/api/v1/runs",
        headers={"Authorization": f"Bearer {_token(secret='not-the-real-secret-but-32-chars-xx')}"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_missing_authorization_header_is_rejected(unauth_client):
    response = await unauth_client.get("/api/v1/runs")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_revoked_jwt_is_rejected(unauth_client):
    token = _token(sub="admin", exp_delta=3600)
    payload = jwt.decode(token, TEST_JWT_SECRET, algorithms=["HS256"])
    auth_service.blacklist_token(payload["jti"], float(payload["exp"]))

    response = await unauth_client.get(
        "/api/v1/runs", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 401


# --- POST /auth/login ----------------------------------------------------


@pytest.mark.asyncio
async def test_login_returns_a_usable_token(unauth_client):
    response = await unauth_client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "test-pass"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["username"] == "admin"
    assert body["token_type"] == "Bearer"

    me = await unauth_client.get(
        "/api/v1/runs", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert me.status_code == 200


@pytest.mark.asyncio
async def test_login_wrong_password_is_401(unauth_client):
    response = await unauth_client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "nope"}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_login_is_rate_limited_after_five_attempts(unauth_client):
    codes = [
        (
            await unauth_client.post(
                "/api/v1/auth/login", json={"username": "admin", "password": "wrong"}
            )
        ).status_code
        for _ in range(6)
    ]
    assert codes[:5] == [401] * 5
    assert codes[5] == 429


# --- POST /auth/signup -------------------------------------------------


@pytest.mark.asyncio
async def test_signup_creates_user_and_logs_in(unauth_client):
    response = await unauth_client.post(
        "/api/v1/auth/signup",
        json={"username": "newbie", "password": "hunter2!", "confirm_password": "hunter2!"},
    )
    assert response.status_code == 201
    assert response.json()["username"] == "newbie"

    login = await unauth_client.post(
        "/api/v1/auth/login", json={"username": "newbie", "password": "hunter2!"}
    )
    assert login.status_code == 200


@pytest.mark.asyncio
async def test_signup_password_mismatch_is_400(unauth_client):
    response = await unauth_client.post(
        "/api/v1/auth/signup",
        json={"username": "mismatch", "password": "hunter2!", "confirm_password": "other!!"},
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_signup_non_alphanumeric_username_is_400(unauth_client):
    response = await unauth_client.post(
        "/api/v1/auth/signup",
        json={"username": "bad name!", "password": "hunter2!", "confirm_password": "hunter2!"},
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_signup_duplicate_username_is_409(unauth_client):
    body = {"username": "dupe", "password": "hunter2!", "confirm_password": "hunter2!"}
    assert (await unauth_client.post("/api/v1/auth/signup", json=body)).status_code == 201
    assert (await unauth_client.post("/api/v1/auth/signup", json=body)).status_code == 409


@pytest.mark.asyncio
async def test_signup_cannot_shadow_env_admin(unauth_client):
    response = await unauth_client.post(
        "/api/v1/auth/signup",
        json={"username": "admin", "password": "hunter2!", "confirm_password": "hunter2!"},
    )
    assert response.status_code == 409


# --- POST /auth/verify & /auth/logout --------------------------------


@pytest.mark.asyncio
async def test_verify_reports_token_validity(unauth_client):
    ok = await unauth_client.post(
        "/api/v1/auth/verify", headers={"Authorization": f"Bearer {_token()}"}
    )
    assert ok.status_code == 200
    assert ok.json()["valid"] is True
    assert ok.json()["username"] == "admin"
    assert ok.json()["expires_at"] is not None

    none = await unauth_client.post("/api/v1/auth/verify")
    assert none.json()["valid"] is False

    garbage = await unauth_client.post(
        "/api/v1/auth/verify", headers={"Authorization": "Bearer not-a-jwt"}
    )
    assert garbage.json()["valid"] is False


@pytest.mark.asyncio
async def test_logout_blacklists_the_token(unauth_client):
    login = await unauth_client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "test-pass"}
    )
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    assert (await unauth_client.post("/api/v1/auth/logout", headers=headers)).status_code == 200

    assert (await unauth_client.post("/api/v1/auth/verify", headers=headers)).json()["valid"] is False
    assert (await unauth_client.get("/api/v1/runs", headers=headers)).status_code == 401


@pytest.mark.asyncio
async def test_logout_without_token_is_401(unauth_client):
    assert (await unauth_client.post("/api/v1/auth/logout")).status_code == 401
