"""Conventional web-attack tests against the FastAPI backend.

Covers the attack classes the prompt-injection suite does not: rate-limit
evasion via header spoofing, oversized inline JSON bodies, content-type
confusion on uploads, authorization/IDOR behaviour, symlink escapes around
the data directory and SQLi fuzzing as a regression guard.

Known limitations documented rather than faked: chunked-transfer upload
bypass cannot be exercised through the ASGI transport (it always computes
Content-Length); see docs/security/backend-attack-tests.md.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import pytest

from src.api import routes
from src.services import experiments


# ---------------------------------------------------------------------------
# Tier 1a — X-Forwarded-For rate-limit evasion
# ---------------------------------------------------------------------------


@pytest.fixture
def tight_rate_limit(monkeypatch):
    """Shrink the window so a handful of requests exhaust one bucket."""
    from src.services.rate_limit import SlidingWindowRateLimiter

    monkeypatch.setattr(routes, "_RATE_LIMIT_MAX_REQUESTS", 3)
    monkeypatch.setattr(
        routes,
        "_rate_limiter",
        SlidingWindowRateLimiter(3, routes._RATE_LIMIT_WINDOW_SEC),
    )
    return routes


@pytest.fixture
def experiments_dir(tmp_path, monkeypatch):
    """Point dataset storage at a temp dir so tests never touch data/."""
    monkeypatch.setattr("src.services.experiments.DATA_DIR", tmp_path)
    return tmp_path


@pytest.mark.asyncio
async def test_spoofed_forwarded_for_cannot_rotate_buckets(client, tight_rate_limit):
    """Without TRUST_PROXY the socket address keys the bucket, so rotating
    forged X-Forwarded-For values must NOT grant unlimited fresh buckets."""
    for i in range(5):
        response = await client.post(
            "/api/v1/analysis",
            json={"rosbag_id": "nope"},
            headers={"X-Forwarded-For": f"10.0.{i}.1"},
        )
        if i < 3:
            assert response.status_code == 404
        else:
            assert response.status_code == 429


@pytest.mark.asyncio
async def test_trusted_proxy_keys_on_the_last_forwarded_entry(client, tight_rate_limit, monkeypatch):
    """With TRUST_PROXY enabled the LAST XFF entry wins: nginx appends the
    real peer address, so anything before it may be attacker-injected noise."""
    monkeypatch.setattr(routes, "_TRUST_PROXY", True)

    for i in range(5):
        response = await client.post(
            "/api/v1/analysis",
            json={"rosbag_id": "nope"},
            headers={"X-Forwarded-For": f"10.9.9.{i}, 203.0.113.7"},
        )
        if i < 3:
            assert response.status_code == 404
        else:
            assert response.status_code == 429


@pytest.mark.asyncio
async def test_trusted_proxy_disabled_by_default(client, tight_rate_limit, monkeypatch):
    """TRUST_PROXY must be an explicit opt-in, never an accident."""
    monkeypatch.setenv("TRUST_PROXY", "")
    assert routes._TRUST_PROXY is False


# ---------------------------------------------------------------------------
# Tier 1b — Oversized inline JSON bodies
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_diagnose_survives_a_huge_message_list(client):
    """A multi-megabyte inline body must be rejected cleanly, never 500."""
    huge_messages = [{"role": "user", "content": "A" * 4096} for _ in range(2560)]  # ~10 MiB
    response = await client.post("/api/v1/analysis/diagnose", json={"messages": huge_messages})
    assert response.status_code < 500


@pytest.mark.asyncio
async def test_diagnose_survives_deeply_nested_json(client):
    """Deeply nested payloads must not crash the JSON layer or workers."""
    payload = ""
    for _ in range(5_000):
        payload = f'{{"n":{payload or "1"}}}'
    response = await client.post(
        "/api/v1/analysis/diagnose",
        content=f'{{"messages":{payload}}}',
        headers={"content-type": "application/json"},
    )
    assert response.status_code in (400, 413, 422)


@pytest.mark.asyncio
async def test_chat_rejects_absurdly_long_message(client):
    """The chat message field carries its own max-length contract."""
    response = await client.post("/api/v1/chat", json={"message": "A" * 100_000})
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Tier 1c — Content-type confusion on upload
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_garbage_bytes_with_valid_extension_is_stored_but_never_crashes(client, tmp_path, monkeypatch):
    """Extension-only validation means arbitrary bytes under an .mcap name are
    accepted; they must be quarantined safely, not executed or parsed as code."""
    monkeypatch.setattr(experiments, "DATA_DIR", tmp_path / "data")
    garbage = os.urandom(1024)
    response = await client.post(
        "/api/v1/datasets/upload",
        files={"file": ("evil.mcap", io.BytesIO(garbage), "application/octet-stream")},
    )
    # Either rejected at the gate or stored inertly — never a server error.
    assert response.status_code in (200, 201, 400)


@pytest.mark.asyncio
async def test_upload_executable_disguised_as_bag_is_inert(client, tmp_path, monkeypatch):
    """PE/MZ magic bytes under a .bag extension must stay inert data."""
    monkeypatch.setattr(experiments, "DATA_DIR", tmp_path / "data")
    mz_header = b"MZ" + b"\x90" * 512
    response = await client.post(
        "/api/v1/datasets/upload",
        files={"file": ("payload.bag", io.BytesIO(mz_header), "application/octet-stream")},
    )
    assert response.status_code in (200, 201, 400)
    if response.status_code in (200, 201):
        stored = Path(response.json()["path"]) if "path" in response.json() else None
        if stored is not None:
            assert stored.read_bytes() == mz_header  # stored verbatim, untouched


# ---------------------------------------------------------------------------
# Tier 2 — Authorization / IDOR / filesystem edges
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_run_ids_do_not_leak_other_runs(client, experiments_dir):
    """Single-tenant model: object ids are capability-free but a wrong id must
    yield 404, never another tenant's (or any other) run's data."""
    for run_id in ("someone-elses-run", "..", "no-such-run"):
        response = await client.get(f"/api/v1/analysis/{run_id}")
        assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_unknown_or_foreign_dataset_returns_404(client, experiments_dir):
    response = await client.delete("/api/v1/datasets/not-a-real-dataset")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_review_decision_unknown_id_returns_404(client, experiments_dir):
    response = await client.post("/api/v1/review/no-such-item/decision", json={"verdict": "approved"})
    assert response.status_code == 404


def test_symlink_inside_data_dir_does_not_escape_deletion(tmp_path, monkeypatch):
    """Deleting a dataset folder must not follow symlinks out of data/."""
    victim = tmp_path / "victim.txt"
    victim.write_text("do not delete me")
    data_root = tmp_path / "data"
    dataset = data_root / "symtest"
    dataset.mkdir(parents=True)
    try:
        (dataset / "escape.db3").symlink_to(victim)
    except OSError:
        pytest.skip("Symlink creation not permitted in this environment")

    monkeypatch.setattr(experiments, "DATA_DIR", data_root)
    experiments.delete_experiment("symtest")

    assert victim.exists(), "deletion followed a symlink out of data/"


@pytest.mark.asyncio
async def test_export_window_sec_lower_bound_is_enforced(client):
    """window_sec below the declared floor must be rejected by validation
    rather than reaching the aggregation loop (CPU-amplification guard)."""
    response = await client.get("/api/v1/analysis/some-run/export/windows?window_sec=0")
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Tier 3 — SQLi fuzzing (regression guard over parameterized queries)
# ---------------------------------------------------------------------------


SQLI_PROBES = [
    "' OR '1'='1",
    "'; DROP TABLE runs;--",
    "1' UNION SELECT sql FROM sqlite_master--",
    '" OR ""="',
]


@pytest.mark.asyncio
async def test_sqli_probes_on_run_and_review_params_are_inert(client, experiments_dir):
    """All queries are parameterized; probes must come back empty/404 and
    leave the schema intact."""
    for probe in SQLI_PROBES:
        assert (await client.get(f"/api/v1/analysis/{probe}")).status_code == 404
        review = await client.get("/api/v1/review", params={"status": probe})
        assert review.status_code in (200, 422)
        decision = await client.post(
            "/api/v1/review/probe/decision",
            json={"verdict": "approved", "reviewer": probe},
        )
        assert decision.status_code in (200, 404, 422)
    datasets = await client.get("/api/v1/datasets")
    assert datasets.status_code == 200  # application DB still healthy
