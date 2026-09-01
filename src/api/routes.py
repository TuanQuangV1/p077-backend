"""RAV-13 Diagnostics API routes.

All state is persisted in SQLite via :mod:`src.services.run_store` (runs,
detections, AI results, review queue) instead of module-level dicts, so data
survives restarts and tests stay isolated. Optional API-token auth and
in-memory rate limiting protect the public endpoints.
"""

import datetime
import functools
import logging
import os
import json
import time
from collections import Counter, defaultdict
from collections.abc import Iterator
from itertools import chain
from pathlib import Path
from typing import Any

import jwt

from src.services import auth as auth_service

import asyncio

import anyio
import httpx
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse

from src.config import get_settings
from src.models.schemas import (
    AIResultSummary,
    AnalysisCreateRequest,
    AnalysisCreateResponse,
    AnalysisDetailResponse,
    AnalysisRun,
    ChatRequest,
    ChatResponse,
    DashboardOverviewResponse,
    DashboardReviewDecisionRequest,
    DashboardReviewDecisionResponse,
    DatasetItem,
    DatasetListResponse,
    DiagnosticsExplanationRequest,
    DiagnosticsExplanationResponse,
    DiagnosticsRequest,
    DiagnosticsSummaryResponse,
    DiagnosticsThresholdsResponse,
    DiagnosticsThresholdsUpdateRequest,
    HealthSummaryResponse,
    HiltFixRequest,
    HiltFixResponse,
    HiltSummary,
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    ReviewItem,
    ReviewListResponse,
    ReviewRuleStat,
    ReviewRuleStatsResponse,
    ReviewStatsResponse,
    ReviewStatsRun,
    RunListResponse,
    RunRootCause,
    SignupRequest,
    SignupResponse,
    VerifyResponse,
)
from src.services import run_store
from src.services.analysis import (
    _anomaly_summaries,
    _build_ai_results,
    _configured_model,
    _kind_labels,
    _pending_run_from_dataset,
    recording_bounds,
    run_analysis,
    select_run_root_cause,
)
from src.services.bag_stream import iter_bag_messages
from src.services.diagnostics import detect_anomalies, parse_mcap_file
from src.services.diagnostics_config import merge_diagnostics_thresholds, save_diagnostics_thresholds
from src.services.health import (
    DEEP_DIVE_TRIGGER_THRESHOLD,
    build_deep_dive_prompt,
    compute_health_summary,
    should_deep_dive,
)
from src.services.iterative_debug import IterativeDebugger
from src.services.rate_limit import SlidingWindowRateLimiter
from src.services.window_export import iter_window_jsonl_lines
from src.services.experiments import (
    MAX_UPLOAD_BYTES,
    delete_experiment,
    experiment_bag_files,
    list_experiments,
    save_uploaded_rosbag,
)
from src.services.leak_guard import response_is_safe
from src.services.llm import (
    CHAT_SYSTEM_PROMPT,
    chat_completion,
    check_llm_health,
    explain_diagnostics,
    is_llm_configured,
)

logger = logging.getLogger(__name__)

_BLOCKED_RESPONSE_TEXT = (
    "Response blocked by security filter: the model output failed the "
    "prompt-injection leak check. Please rephrase your request."
)

_RATE_LIMIT_MAX_REQUESTS = int(os.environ.get("RATE_LIMIT_MAX_REQUESTS", "120"))
_RATE_LIMIT_WINDOW_SEC = float(os.environ.get("RATE_LIMIT_WINDOW_SEC", "60"))

_rate_limiter = SlidingWindowRateLimiter(_RATE_LIMIT_MAX_REQUESTS, _RATE_LIMIT_WINDOW_SEC)

# Stricter rate limiter for login (brute-force protection)
_LOGIN_RATE_LIMIT_MAX = int(os.environ.get("LOGIN_RATE_LIMIT_MAX", "5"))
_LOGIN_RATE_LIMIT_WINDOW_SEC = float(os.environ.get("LOGIN_RATE_LIMIT_WINDOW_SEC", "60"))
_login_rate_limiter = SlidingWindowRateLimiter(_LOGIN_RATE_LIMIT_MAX, _LOGIN_RATE_LIMIT_WINDOW_SEC)


# Environments that must never run with auth disabled. `staging` used to fall
# on the permissive side of `app_env != "production"`, which meant a staging
# deploy that forgot JWT_SECRET served every protected route unauthenticated,
# attributing each request to the `admin` owner.
_AUTH_REQUIRED_ENVS = frozenset({"production", "staging"})


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    if not authorization.startswith("Bearer "):
        return None
    token = authorization[7:].strip()
    return token if token else None


def get_current_user(authorization: str | None = Header(default=None)) -> str:
    """Return current username from JWT, or 'admin' when auth bypassed in non-prod."""
    settings = get_settings()
    jwt_secret = getattr(settings, "jwt_secret", "")
    app_env = getattr(settings, "app_env", "development")
    if not jwt_secret:
        if app_env not in _AUTH_REQUIRED_ENVS:
            return "admin"
        raise HTTPException(status_code=503, detail="JWT_SECRET not configured")

    token = _extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="invalid or missing JWT token")
    try:
        payload = auth_service.decode_token(token)
        sub = payload.get("sub")
        if not sub or not isinstance(sub, str):
            raise HTTPException(status_code=401, detail="invalid JWT token: missing sub")
        return sub
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="JWT token expired") from None
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"invalid JWT token: {exc}") from exc
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="invalid JWT token") from None


def _require_auth(authorization: str | None = Header(default=None)) -> None:
    """100% JWT auth — no static API_AUTH_TOKEN fallback.

    Validates ``Authorization: Bearer <JWT>`` via :mod:`src.services.auth`.
    Raises 401 if missing/invalid/expired/revoked.
    In non-production, when JWT_SECRET is not configured, auth is bypassed
    (open) to keep local dev and existing tests working without token.
    In production, missing secret fails closed with 503.
    """
    # Delegate to get_current_user for validation; discard username
    get_current_user(authorization)


def _require_llm_auth(authorization: str | None = Header(default=None)) -> None:
    """Mandatory JWT auth for LLM endpoints.

    In production, if JWT_SECRET is not configured (empty and fallback is
    insecure), fail closed with 503 instead of allowing anonymous LLM usage.
    """
    settings = get_settings()
    jwt_secret = getattr(settings, "jwt_secret", "")
    app_env = getattr(settings, "app_env", "development")
    # Fail closed in production when JWT secret is not properly configured
    if app_env in _AUTH_REQUIRED_ENVS and not jwt_secret:
        raise HTTPException(
            status_code=503,
            detail="LLM endpoints require JWT_SECRET to be configured",
        )
    # Delegate to standard JWT check
    _require_auth(authorization)


def _check_login_rate_limit(request: Request) -> None:
    """Rate limit for login keyed by client IP + username attempt."""
    # Reuse same IP extraction logic as _check_rate_limit but with login limiter
    client_host = request.client.host if request.client else None
    forwarded_for = request.headers.get("x-forwarded-for")
    if _TRUST_PROXY:
        key_candidate: str | None = None
        if forwarded_for:
            parts = [p.strip() for p in forwarded_for.split(",") if p.strip()]
            if parts:
                key_candidate = parts[-_TRUST_PROXY_HOPS] if len(parts) >= _TRUST_PROXY_HOPS else parts[0]
                if key_candidate:
                    key_candidate = key_candidate.strip()
                    if ":" in key_candidate and key_candidate.count(":") == 1 and "." in key_candidate:
                        key_candidate = key_candidate.split(":")[0]
                    if not key_candidate:
                        key_candidate = None
        if not key_candidate:
            x_real = request.headers.get("x-real-ip")
            if x_real and x_real.strip():
                key_candidate = x_real.strip().split(":")[0]
        key = key_candidate or client_host or "unknown"
    else:
        key = client_host or "unknown"
    # Differentiate by endpoint to avoid cross-polluting with general limiter
    key = f"login:{key}"
    if not _login_rate_limiter.allow(key):
        raise HTTPException(status_code=429, detail="rate limit exceeded")


# Whether the deployment sits behind a trusted reverse proxy (nginx) whose
# X-Forwarded-For header can be believed. Only set TRUST_PROXY=1 in
# environments where the proxy is trusted; otherwise a client could spoof
# unlimited fresh rate-limit buckets.
_TRUST_PROXY_RAW = os.environ.get("TRUST_PROXY", "").strip()
_TRUST_PROXY = _TRUST_PROXY_RAW.lower() in ("1", "true", "yes") or (
    _TRUST_PROXY_RAW.isdigit() and int(_TRUST_PROXY_RAW) >= 1
)

# How many trusted proxy hops to peel from the right of X-Forwarded-For.
# With `TRUST_PROXY_HOPS=1` (default) the last entry is trusted (single nginx
# using ``$proxy_add_x_forwarded_for``). With an extra load balancer in front
# of nginx set ``TRUST_PROXY_HOPS=2`` — otherwise the last entry is an
# internal IP and all external clients collapse into one rate-limit bucket.
_TRUST_PROXY_HOPS_RAW = os.environ.get("TRUST_PROXY_HOPS", "").strip()
# Allow TRUST_PROXY="2" as shorthand for hops=2 when HOPS not set explicitly.
if not _TRUST_PROXY_HOPS_RAW and _TRUST_PROXY_RAW.isdigit():
    _TRUST_PROXY_HOPS_RAW = _TRUST_PROXY_RAW
if not _TRUST_PROXY_HOPS_RAW:
    _TRUST_PROXY_HOPS_RAW = "1"
try:
    _TRUST_PROXY_HOPS = int(_TRUST_PROXY_HOPS_RAW)
except ValueError:
    _TRUST_PROXY_HOPS = 1
_TRUST_PROXY_HOPS = max(_TRUST_PROXY_HOPS, 1)


def _check_rate_limit(request: Request) -> None:
    """Sliding-window in-memory rate limit keyed by client IP.

    The forwarded header is only honoured when ``TRUST_PROXY`` is enabled,
    because any client that can reach the backend directly (or through an
    appending proxy chain) may inject its own ``X-Forwarded-For`` values and
    rotate them per request to evade the limit entirely. Untrusted callers are
    keyed by their direct socket address.

    ``TRUST_PROXY_HOPS`` controls how many entries to peel from the right of
    ``X-Forwarded-For``. Nginx uses ``$proxy_add_x_forwarded_for`` which
    *appends* the real peer address. With one trusted proxy the last entry is
    the client; with an L4 LB + nginx the last entry is the LB's internal IP
    and the client is at ``-2``. Operators must set hops to the number of
    trusted proxies, otherwise all external traffic collapses into one bucket.
    """

    client_host = request.client.host if request.client else None
    forwarded_for = request.headers.get("x-forwarded-for")
    if _TRUST_PROXY:
        key_candidate: str | None = None
        if forwarded_for:
            parts = [p.strip() for p in forwarded_for.split(",") if p.strip()]
            if parts:
                # Peel HOPS entries from the right: HOPS=1 -> last, HOPS=2 -> second last.
                if len(parts) >= _TRUST_PROXY_HOPS:  # noqa: SIM108
                    key_candidate = parts[-_TRUST_PROXY_HOPS]
                else:
                    # Header shorter than trusted chain — fall back to first entry
                    # rather than an internal hop that would group all traffic.
                    key_candidate = parts[0]
                if key_candidate:
                    key_candidate = key_candidate.strip()
                    # Strip port if present (e.g. "1.2.3.4:1234") and zone id
                    if ":" in key_candidate and key_candidate.count(":") == 1 and "." in key_candidate:
                        key_candidate = key_candidate.split(":")[0]
                    if not key_candidate:
                        key_candidate = None
        # Fallback to X-Real-IP when XFF missing or produced no usable candidate
        if not key_candidate:
            x_real = request.headers.get("x-real-ip")
            if x_real and x_real.strip():
                key_candidate = x_real.strip().split(":")[0]
        key = key_candidate or client_host or "unknown"
    else:
        key = client_host or "unknown"
    if not _rate_limiter.allow(key):
        raise HTTPException(status_code=429, detail="rate limit exceeded")


# Public router — no auth (for login/verify)
public_router = APIRouter()

# Protected router — 100% JWT
protected_router = APIRouter(dependencies=[Depends(_require_auth)])

# Backwards-compat alias: some tests import `router` directly
router = protected_router


# ── Auth endpoints ───────────────────────────────────────────────
@public_router.post("/auth/login", response_model=LoginResponse)
async def login(
    payload: LoginRequest,
    _rate_limited: None = Depends(_check_login_rate_limit),
) -> LoginResponse:
    """Authenticate with username/password and receive a JWT.

    Rate-limited to 5 req/min per IP to mitigate brute-force.
    """
    settings = get_settings()
    # In production require JWT_SECRET to be configured properly
    if settings.app_env in _AUTH_REQUIRED_ENVS and not settings.jwt_secret:
        raise HTTPException(status_code=503, detail="JWT_SECRET not configured")

    # In dev/test if no password configured at all, allow login with default admin/admin?
    # Instead we rely on verify_credentials which handles empty password case per env.
    if not auth_service.verify_credentials(payload.username, payload.password):
        logger.warning(
            "auth.login_failed",
            extra={
                "diagnostics": {
                    "event": "auth.login_failed",
                    "level": "warning",
                    "details": {"username": payload.username},
                }
            },
        )
        raise HTTPException(status_code=401, detail="invalid credentials")

    token, _jti, expires_in = auth_service.create_access_token(payload.username)
    logger.info(
        "auth.login_success",
        extra={
            "diagnostics": {
                "event": "auth.login_success",
                "level": "info",
                "details": {"username": payload.username},
            }
        },
    )
    return LoginResponse(
        access_token=token,
        token_type="Bearer",
        expires_in=expires_in,
        username=payload.username,
    )


@public_router.post("/auth/signup", response_model=SignupResponse, status_code=status.HTTP_201_CREATED)
async def signup(
    payload: SignupRequest,
    _rate_limited: None = Depends(_check_login_rate_limit),
) -> SignupResponse:
    """Fake signup — tạo user in-memory (không DB) và trả JWT.

    - `username` 3-64 ký tự, `password` >=6
    - `confirm_password` phải khớp `password`
    - Trả 409 nếu username đã tồn tại (kể cả admin env)
    - Rate-limit 5 req/min/IP như login
    """
    settings = get_settings()
    if settings.app_env in _AUTH_REQUIRED_ENVS and not settings.jwt_secret:
        raise HTTPException(status_code=503, detail="JWT_SECRET not configured")

    if payload.password != payload.confirm_password:
        raise HTTPException(status_code=400, detail="passwords do not match")

    # Simple username validation: alphanumeric + _ - .
    if not payload.username.replace("_", "").replace("-", "").replace(".", "").isalnum():
        raise HTTPException(status_code=400, detail="username must be alphanumeric with _ - . allowed")

    if not auth_service.register_user(payload.username, payload.password):
        raise HTTPException(status_code=409, detail="username already exists")

    token, _jti, expires_in = auth_service.create_access_token(payload.username)
    logger.info(
        "auth.signup_success",
        extra={
            "diagnostics": {
                "event": "auth.signup_success",
                "level": "info",
                "details": {"username": payload.username},
            }
        },
    )
    return SignupResponse(
        access_token=token,
        token_type="Bearer",
        expires_in=expires_in,
        username=payload.username,
    )


@public_router.post("/auth/verify", response_model=VerifyResponse)
async def verify_token(authorization: str | None = Header(default=None)) -> VerifyResponse:
    """Verify a JWT and return validity.

    Does NOT raise 401 for invalid tokens — returns ``valid:false`` instead,
    making it easy for the frontend to check localStorage tokens without
    treating expiration as an error.
    """
    token = _extract_bearer_token(authorization)
    if not token:
        return VerifyResponse(valid=False, username=None, expires_at=None)
    try:
        payload = auth_service.decode_token(token)
        exp = payload.get("exp")
        expires_at = None
        if exp:
            try:
                expires_at = datetime.datetime.fromtimestamp(float(exp), tz=datetime.UTC).isoformat()
            except Exception:
                expires_at = None
        return VerifyResponse(valid=True, username=str(payload.get("sub")), expires_at=expires_at)
    except Exception:
        return VerifyResponse(valid=False, username=None, expires_at=None)


@protected_router.post("/auth/logout", response_model=LogoutResponse)
async def logout(authorization: str | None = Header(default=None)) -> LogoutResponse:
    """Revoke the current JWT (blacklist by jti until exp).

    Requires a valid JWT (protected). After logout, ``verify`` will return
    ``valid:false`` for that token.
    """
    token = _extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="invalid or missing JWT token")
    try:
        payload = auth_service.decode_token(token)
        jti = payload.get("jti")
        exp = payload.get("exp")
        if jti and exp:
            auth_service.blacklist_token(str(jti), float(exp))
        elif jti:
            # Fallback exp = now + remaining TTL
            auth_service.blacklist_token(str(jti), time.time() + 3600)
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"invalid JWT token: {exc}") from exc
    return LogoutResponse(ok=True, message="Logged out successfully")


def _resolve_diagnostics_file_path(file_path: str) -> Path:
    """Resolve and validate a diagnostics file path inside ``data/diagnostics``.

    Only relative paths inside ``data/diagnostics`` are accepted to prevent
    path traversal. Returns the resolved ``Path`` or raises an HTTPException.

    Args:
        file_path: Relative path to the diagnostics file (e.g. ``bag_01/mcap.jsonl``).

    Returns:
        Resolved ``Path`` verified to live inside the data directory.

    Raises:
        HTTPException 400: The path is invalid or escapes the allowed directory.
        HTTPException 404: The file does not exist.
    """
    requested_path = Path(file_path)
    if requested_path.is_absolute() or ".." in requested_path.parts:
        raise HTTPException(status_code=400, detail="invalid diagnostics file path")

    base_dir = (Path.cwd() / "data" / "diagnostics").resolve()
    resolved = (base_dir / requested_path).resolve()
    if resolved != base_dir and base_dir not in resolved.parents:
        raise HTTPException(status_code=400, detail="invalid diagnostics file path")

    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail="diagnostics file not found")

    return resolved


def _enrich_analysis_fields(owner: str | None) -> dict[str, dict[str, Any]]:
    """Build rosbagId -> latest run map for analysisStatus enrichment."""
    try:
        runs = run_store.list_runs(owner)
    except Exception:
        return {}
    latest: dict[str, dict[str, Any]] = {}
    for run in runs:
        rid = str(run.get("rosbagId", ""))
        if rid and rid not in latest:
            latest[rid] = run
    return latest


def _load_datasets(owner: str | None = None) -> list[DatasetItem]:
    """Scan data/ subfolders for rosbag datasets (cached by :func:`list_experiments`)."""
    exps = list_experiments(owner)
    latest_by_bag = _enrich_analysis_fields(owner)
    items: list[DatasetItem] = []
    for exp in exps:
        run = latest_by_bag.get(exp["id"])
        if run is not None:
            analysis_status = str(run.get("status", "succeeded"))
            anomaly_count = run.get("anomalyCount")
            worst = run.get("worstSeverity")
            last_run_id = run.get("id")
        else:
            analysis_status = "not_analyzed"
            anomaly_count = None
            worst = None
            last_run_id = None
        items.append(
            DatasetItem(
                id=exp["id"],
                name=exp["name"],
                robotType=exp["robotType"],
                sizeBytes=exp["sizeBytes"],
                durationSec=exp["durationSec"],
                recordedAt=exp["recordedAt"],
                uploadedAt=exp["uploadedAt"],
                status=exp["status"],
                messageCount=exp["messageCount"],
                topics=exp["topics"],
                site=exp["site"],
                rosVersion=exp["rosVersion"],
                analysisStatus=analysis_status,
                analysisAnomalyCount=anomaly_count,
                worstSeverity=worst,
                lastRunId=last_run_id,
            )
        )
    return items


def _p95(values: list[int]) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))
    return int(ordered[idx])


@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    _rate_limited: None = Depends(_check_rate_limit),
    _llm_auth: None = Depends(_require_llm_auth),
) -> ChatResponse:
    """Chat with the LLM through an OpenAI/Anthropic endpoint (httpx, manual tool-calling).

    Sends the message directly to the configured LLM provider. When the LLM is not configured,
    returns a guidance response instead of an error.

    Args:
        request: User message content.

    Returns:
        ``ChatResponse`` containing the answer.

    Raises:
        HTTPException 500: The LLM upstream failed while processing the request.
    """
    if not is_llm_configured():
        return ChatResponse(
            response=(
                "LLM chưa được cấu hình. Cấu hình llm_provider='openai' kèm "
                "openai_api_key, hoặc llm_provider='anthropic' kèm "
                "anthropic_api_key, để bật chat thật."
            ),
            analysis="",
        )
    try:
        result = await anyio.to_thread.run_sync(
            chat_completion,
            [
                {"role": "system", "content": CHAT_SYSTEM_PROMPT},
                {"role": "user", "content": request.message},
            ],
        )
        content = result["message"].get("content", "")
        if not response_is_safe(content):
            logger.warning(
                "chat.response_blocked",
                extra={
                    "diagnostics": {
                        "event": "chat.response_blocked",
                        "level": "warning",
                        "details": {"reason": "prompt_injection_leak_check"},
                    }
                },
            )
            content = _BLOCKED_RESPONSE_TEXT
        return ChatResponse(response=content, analysis="")
    except Exception as e:
        logger.warning(
            "chat.upstream_failed",
            extra={
                "diagnostics": {
                    "event": "chat.upstream_failed",
                    "level": "warning",
                    "details": {"error_type": type(e).__name__},
                }
            },
        )
        raise HTTPException(status_code=500, detail="LLM request failed; please try again later") from e


@router.get("/status")
async def agent_status() -> dict[str, str]:
    """Check the API health status.

    Returns:
        Dict with the status and version name.
    """
    return {"status": "ready", "agent": "RAV-13 Diagnostics API v1.0"}


@router.get("/llm/health")
async def llm_health(refresh: bool = Query(default=False)) -> dict[str, Any]:
    """Prove the configured LLM actually answers, not just that a key is set.

    `is_llm_configured()` only checks the config shape (key present, model id
    well-formed); this calls the provider with a minimal prompt so a reachable-
    but-broken setup (wrong model id, revoked key, upstream outage) shows up
    before an analysis run silently falls back to canned text. Cached 60s
    server-side (see `check_llm_health`) so polling this from the UI is cheap;
    pass `refresh=true` to force a fresh call.

    Returns:
        Dict with ``provider``, ``model``, ``ok``, ``latencyMs``, ``error``.
    """
    return await anyio.to_thread.run_sync(check_llm_health, refresh)


@router.get("/datasets", response_model=DatasetListResponse)
async def datasets(
    limit: int | None = Query(default=None, ge=1),
    offset: int | None = Query(default=None, ge=0),
    owner: str = Depends(get_current_user),
) -> DatasetListResponse:
    """List uploaded rosbag datasets, scanned from data/<owner>/.

    Args:
        limit: Maximum number of items to return (pagination).
        offset: Starting position for pagination.
        owner: Current user (from JWT).

    Returns:
        ``DatasetListResponse`` with the dataset list and the total count.
    """
    items = await anyio.to_thread.run_sync(_load_datasets, owner)
    total = len(items)
    if offset is not None:
        items = items[offset:]
    if limit is not None:
        items = items[:limit]
    return DatasetListResponse(items=items, total=total)


@router.post("/datasets/upload", response_model=DatasetItem, status_code=status.HTTP_201_CREATED)
async def upload_dataset(
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    _rate_limited: None = Depends(_check_rate_limit),
    owner: str = Depends(get_current_user),
) -> DatasetItem:
    """Upload a new rosbag (.db3/.mcap/.bag) or rosbag2 zip file.

    Stores the file under ``data/<id>/`` and generates minimal ``metadata.yaml``
    if missing, then returns the matching ``DatasetItem``. When the uploaded
    bag's content (SHA-256 of the primary bag file) matches an existing
    dataset, the new folder is discarded and the *existing* dataset's item is
    returned instead, with ``duplicateOf`` set to its id and a 200 status
    (rather than 201) so callers can tell a duplicate from a fresh upload.

    Args:
        request: Original request (used to check ``Content-Length``).
        response: Injected response, used to downgrade the status to 200 on a
            detected duplicate.
        file: Uploaded multipart file.

    Returns:
        ``DatasetItem`` describing the just-stored rosbag, or the pre-existing
        one it duplicates.

    Raises:
        HTTPException 400: Unsupported format or unsafe zip content.
        HTTPException 413: Upload exceeds the size limit.
    """
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="upload exceeds size limit")
    try:
        item = await anyio.to_thread.run_sync(save_uploaded_rosbag, file.filename or "", file.file, owner)
    except ValueError as e:
        if "size limit" in str(e):
            raise HTTPException(status_code=413, detail=str(e)) from e
        raise HTTPException(status_code=400, detail=str(e)) from e
    if item.get("duplicateOf"):
        response.status_code = status.HTTP_200_OK
        logger.info(
            "datasets.upload_deduplicated",
            extra={
                "diagnostics": {
                    "event": "datasets.upload_deduplicated",
                    "level": "info",
                    "details": {"existingId": item["id"]},
                }
            },
        )
        return DatasetItem(**item)
    logger.info(
        "datasets.uploaded",
        extra={
            "diagnostics": {
                "event": "datasets.uploaded",
                "level": "info",
                "details": {"id": item["id"], "sizeBytes": item["sizeBytes"], "owner": owner},
            }
        },
    )
    # New datasets have no run yet — enrich upload response so the
    # registry can render "chưa phân tích" immediately without refetch.
    if "analysisStatus" not in item or item.get("analysisStatus") is None:
        item["analysisStatus"] = "not_analyzed"
        item.setdefault("analysisAnomalyCount", None)
        item.setdefault("worstSeverity", None)
        item.setdefault("lastRunId", None)
    return DatasetItem(**item)


@router.delete("/datasets/{dataset_id}", response_model=dict)
async def delete_dataset(dataset_id: str, owner: str = Depends(get_current_user)) -> dict[str, str | bool]:
    """Delete a dataset (folder) under data/.

    Args:
        dataset_id: ID of the dataset to delete (folder name).

    Returns:
        Dict confirming the deletion result.

    Raises:
        HTTPException 404: No dataset found with the given ID.
    """
    deleted = await anyio.to_thread.run_sync(delete_experiment, dataset_id, owner)
    if not deleted:
        raise HTTPException(status_code=404, detail="dataset not found")
    logger.info(
        "datasets.deleted",
        extra={
            "diagnostics": {
                "event": "datasets.deleted",
                "level": "info",
                "details": {"id": dataset_id, "owner": owner},
            }
        },
    )
    return {"ok": True, "id": dataset_id}


@router.get("/runs", response_model=RunListResponse)
async def list_runs(
    limit: int = Query(default=50, ge=1, le=500),
    owner: str = Depends(get_current_user),
) -> RunListResponse:
    """List the current user's analysis runs, newest first, with real LLM usage.

    Backs the LLM Observability console tab (`model`, `totalLatencyMs`,
    `promptTokens`, `completionTokens`, `costUsd` per run) — replaces the
    previous fabricated vLLM/GPU telemetry, which had no real backing data
    since this project calls providers over plain HTTP.

    Args:
        limit: Maximum number of runs to return.
        owner: Current user (from JWT).

    Returns:
        ``RunListResponse`` with the matching runs and the true total count.
    """
    runs = await anyio.to_thread.run_sync(run_store.list_runs, owner)
    return RunListResponse(items=[AnalysisRun(**run) for run in runs[:limit]], total=len(runs))


@router.get("/dashboard/overview", response_model=DashboardOverviewResponse)
async def dashboard_overview(owner: str = Depends(get_current_user)) -> DashboardOverviewResponse:
    """Return dashboard overview metrics computed from real data (per-user).

    Every metric (rosbag count, runs, anomalies, severity, pending reviews,
    trend) is derived from datasets and persisted runs of the current owner
    only; no fake data remains.

    Returns:
        ``DashboardOverviewResponse`` containing all overview data.
    """
    # Parallelize independent IO: datasets (FS), runs (DB), review_items (DB)
    datasets_task = anyio.to_thread.run_sync(_load_datasets, owner)
    runs_task = anyio.to_thread.run_sync(run_store.list_runs, owner)
    review_task = anyio.to_thread.run_sync(run_store.list_review_items, None, owner)
    datasets, runs, review_items = await asyncio.gather(datasets_task, runs_task, review_task)
    anomalies_by_run = await anyio.to_thread.run_sync(
        run_store.get_runs_anomalies, [run["id"] for run in runs]
    )
    all_anomalies: list[dict[str, Any]] = [
        anomaly for run in runs for anomaly in anomalies_by_run.get(run["id"], [])
    ]

    succeeded = [r for r in runs if r["status"] == "succeeded"]
    runs_with_issues = [r for r in succeeded if r["anomalyCount"] > 0]
    total_messages = sum(ds.messageCount for ds in datasets)
    total_hours = sum(ds.durationSec for ds in datasets) / 3600.0
    latency_ms = [r["totalLatencyMs"] for r in succeeded]

    kind_counts = Counter(str(a.get("kind", "unknown")) for a in all_anomalies)
    severity_counts = Counter(str(a.get("severity", "low")) for a in all_anomalies)
    open_critical = sum(1 for a in all_anomalies if a.get("severity") == "critical")

    trend_by_date: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"bags": set(), "anomalies": 0, "latencies": [], "cost": 0.0}
    )
    for run in runs:
        date = run["startedAt"][:10]
        entry = trend_by_date[date]
        entry["bags"].add(run["rosbagId"])
        entry["anomalies"] += run["anomalyCount"]
        entry["latencies"].append(run["totalLatencyMs"])
        entry["cost"] += run["costUsd"]

    return DashboardOverviewResponse(
        totals={
            "rosbags": len(datasets),
            "analyzed": len(succeeded),
            "messages": total_messages,
            "hoursOfData": round(total_hours, 2),
            "runsWithIssuesPct": (round(len(runs_with_issues) / len(succeeded) * 100, 1) if succeeded else 0.0),
            "anomalies": len(all_anomalies),
            "criticalOpen": open_critical,
            "meanTimeToDiagnoseSec": (int(sum(latency_ms) / len(latency_ms) / 1000) if latency_ms else 0),
            "inferenceCostUsd": round(sum(r["costUsd"] for r in runs), 4),
            "tokens": sum(r["promptTokens"] + r["completionTokens"] for r in runs),
            "reviewPending": sum(1 for r in review_items if r["reviewStatus"] == "pending"),
        },
        topIssues=[
            {
                "kind": kind,
                "label": _kind_labels().get(kind, kind.replace("_", " ").title()),
                "count": count,
            }
            for kind, count in kind_counts.most_common(5)
        ],
        severity=[
            {"severity": level, "count": severity_counts.get(level, 0)}
            for level in ("critical", "high", "medium", "low")
        ],
        trend=[
            {
                "date": date,
                "bags": len(entry["bags"]),
                "anomalies": entry["anomalies"],
                "p95Ms": _p95(entry["latencies"]),
                "costUsd": round(entry["cost"], 4),
            }
            for date, entry in sorted(trend_by_date.items())
        ],
        recentRuns=[AnalysisRun(**run) for run in runs[:5]],
    )


@router.post("/analysis", response_model=AnalysisCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_analysis(
    request: AnalysisCreateRequest,
    background_tasks: BackgroundTasks,
    _rate_limited: None = Depends(_check_rate_limit),
    owner: str = Depends(get_current_user),
) -> AnalysisCreateResponse:
    """Queue diagnostics for a dataset and run it in background (per-owner).

    The request returns immediately (202) with a ``running`` placeholder run so
    the frontend proxy is never held open for the 40-800s detection phase that
    previously caused ``socket hang up`` / ``proxy timeout``. The real
    ``run_analysis`` pipeline (detect → LLM → persist) executes after the response
    via ``BackgroundTasks`` and overwrites the placeholder with the final
    ``succeeded``/``failed`` run. Callers poll ``GET /analysis/{id}`` until
    ``status`` leaves ``running``.

    Args:
        request: Analysis request (rosbag id, optional model).
        background_tasks: FastAPI background task queue.
        owner: Current user.

    Returns:
        ``AnalysisCreateResponse`` with the queued run and the WebSocket channel.

    Raises:
        HTTPException 404: No dataset found with the given ID for this owner.
    """
    datasets = await anyio.to_thread.run_sync(_load_datasets, owner)
    match = next((ds for ds in datasets if ds.id == request.rosbag_id), None)
    if not match:
        raise HTTPException(status_code=404, detail="dataset not found")

    # In production the analysis can take 40-800s (detect + LLM) — never block the
    # HTTP worker that the frontend proxy waits on. Queue a placeholder run and
    # finish in BackgroundTasks. In test/dev keep the old synchronous contract so
    # existing tests that assert ``status == succeeded`` immediately still pass.
    settings = get_settings()
    if settings.app_env == "production":
        resolved_model = request.model or _configured_model()
        ds_dict = {"id": match.id, "name": match.name, "robotType": match.robotType}
        pending = _pending_run_from_dataset(ds_dict, resolved_model)
        pending = pending.model_copy(update={"status": "running", "progress": 5, "stage": "queued"})

        def _save_pending() -> None:
            try:
                run_store.save_run(pending.model_dump(), owner)
            except Exception:
                logger.exception(
                    "analysis.queue_save_failed",
                    extra={"diagnostics": {"event": "analysis.queue_save_failed", "level": "warning"}},
                )

        await anyio.to_thread.run_sync(_save_pending)

        async def _background() -> None:
            try:
                await anyio.to_thread.run_sync(lambda: run_analysis(request.rosbag_id, request.model, owner))
            except Exception as exc:  # pragma: no cover - background failure is logged, not surfaced
                logger.exception(
                    "analysis.background_failed",
                    extra={
                        "diagnostics": {
                            "event": "analysis.background_failed",
                            "level": "error",
                            "details": {"rosbag_id": request.rosbag_id, "error": str(exc)},
                        }
                    },
                )

        background_tasks.add_task(_background)

        return AnalysisCreateResponse(
            run=pending,
            channel=f"/ws/runs/{pending.id}",
        )

    # Non-production: synchronous for test determinism
    result = await anyio.to_thread.run_sync(run_analysis, request.rosbag_id, request.model, owner)
    run = result["run"]
    return AnalysisCreateResponse(
        run=run,
        channel=f"/ws/runs/{run.id}",
    )


@router.get("/analysis/thresholds", response_model=DiagnosticsThresholdsResponse)
async def get_thresholds() -> DiagnosticsThresholdsResponse:
    """Get the current diagnostics thresholds.

    Returns:
        ``DiagnosticsThresholdsResponse`` with all thresholds in effect.
    """
    # `get_diagnostics_thresholds` returns only the persisted delta (see
    # `save_diagnostics_thresholds`'s docstring) — merge it onto the code
    # defaults to report the full effective set, not just overridden keys.
    thresholds = await anyio.to_thread.run_sync(merge_diagnostics_thresholds)
    logger.debug(
        "diagnostics.thresholds.read",
        extra={
            "diagnostics": {
                "event": "diagnostics.thresholds.read",
                "level": "debug",
                "details": {"thresholds": thresholds},
            }
        },
    )
    return DiagnosticsThresholdsResponse(thresholds=thresholds)


@router.post("/analysis/thresholds", response_model=DiagnosticsThresholdsResponse)
async def update_thresholds(
    payload: DiagnosticsThresholdsUpdateRequest,
) -> DiagnosticsThresholdsResponse:
    """Update diagnostics thresholds and persist them to configuration.

    Args:
        payload: New thresholds to apply (merged with the current configuration).

    Returns:
        ``DiagnosticsThresholdsResponse`` with the thresholds after saving.
    """
    thresholds = await anyio.to_thread.run_sync(save_diagnostics_thresholds, payload.thresholds)
    logger.info(
        "diagnostics.thresholds.updated",
        extra={
            "diagnostics": {
                "event": "diagnostics.thresholds.updated",
                "level": "info",
                "details": {"thresholds": thresholds},
            }
        },
    )
    return DiagnosticsThresholdsResponse(thresholds=thresholds)


@router.get("/analysis/{run_id}", response_model=AnalysisDetailResponse)
async def get_analysis(run_id: str, owner: str = Depends(get_current_user)) -> AnalysisDetailResponse:
    """Get the detailed results of a single analysis run (per-owner).

    Args:
        run_id: ID of the analysis run to fetch.
        owner: Current user.

    Returns:
        ``AnalysisDetailResponse`` with the run, its rosbag, the real anomaly
        list and the AI results persisted when the run was created.

    Raises:
        HTTPException 404: No run found with the given ID for this owner.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id, owner)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")
    run = AnalysisRun(**run_row)
    datasets = await anyio.to_thread.run_sync(_load_datasets, owner)
    rosbag = next((ds for ds in datasets if ds.id == run.rosbagId), None)
    detections = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    persisted_ai = await anyio.to_thread.run_sync(run_store.get_run_ai_results, run_id)
    if persisted_ai:
        def _coerce_ai(payload: dict[str, Any]) -> dict[str, Any]:
            if "vllmRequestId" in payload and "llmRequestId" not in payload:
                payload = {**payload, "llmRequestId": payload["vllmRequestId"]}
            # also keep alias for serialization
            return payload

        ai_results = [AIResultSummary(**_coerce_ai(result)) for result in persisted_ai]
    else:
        # Only fires for runs whose AI results are missing. The recording bounds
        # are recovered from the detections' own two clocks so the model is
        # prompted in relative seconds, matching the `tRelSec` its evidence rows
        # carry — otherwise one panel narrates 425.1s beside evidence at 66.8s.
        ai_results = _build_ai_results(
            run_id,
            detections,
            recording_bounds(detections, rosbag.durationSec if rosbag else None),
        )
    health = compute_health_summary(detections, total_messages=rosbag.messageCount if rosbag else 0)
    root_cause = select_run_root_cause(detections, ai_results)
    return AnalysisDetailResponse(
        run=run,
        rosbag=rosbag,
        anomalies=_anomaly_summaries(run_id, detections),
        aiResults=ai_results,
        health=health,
        runRootCause=RunRootCause(**root_cause) if root_cause else None,
    )


@router.get("/analysis/{run_id}/health", response_model=HealthSummaryResponse)
async def get_analysis_health(run_id: str, owner: str = Depends(get_current_user)) -> HealthSummaryResponse:
    """Return the Health Summary JSON for a run's persisted detections (per-owner).

    The response is the LLM-friendly context payload: a composite 0-100
    ``health_score``, its green/yellow/red zone, the per-group subscores (log,
    frequency, latency, tf, payload) and detections grouped by indicator. A
    ``trigger_llm_deep_dive`` flag fires when the score drops below the
    ``DEEP_DIVE_TRIGGER_THRESHOLD`` (70), signaling the frontend/agent to run a
    root-cause deep-dive.

    Args:
        run_id: ID of the analysis run to summarize.
        owner: Current user.

    Returns:
        ``HealthSummaryResponse`` wrapping the Health Summary JSON.

    Raises:
        HTTPException 404: No run found with the given ID for this owner.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id, owner)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")
    datasets = await anyio.to_thread.run_sync(_load_datasets, owner)
    rosbag = next((ds for ds in datasets if ds.id == run_row["rosbagId"]), None)
    detections = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    total_messages = rosbag.messageCount if rosbag else 0
    health = compute_health_summary(detections, total_messages=total_messages)
    return HealthSummaryResponse(health=health)


@router.get("/analysis/{run_id}/deep-dive", dependencies=[Depends(_require_llm_auth)])
async def analysis_deep_dive(
    run_id: str,
    deep_dive_threshold: float = Query(default=DEEP_DIVE_TRIGGER_THRESHOLD, ge=0.0, le=100.0),
    owner: str = Depends(get_current_user),
) -> dict[str, object]:
    """Build the LLM deep-dive context for a run (per-owner).

    Returns the Health Summary plus a ready-to-send context prompt. Callers
    should send the ``prompt`` to ``POST /analysis/explain`` (or the LLM chat
    endpoint) whenever ``trigger_llm_deep_dive`` is true or the user clicked a
    red anomaly band on the dashboard timeline.

    Args:
        run_id: ID of the analysis run.
        deep_dive_threshold: Optional override of the deep-dive trigger score.
        owner: Current user.

    Returns:
        Dict with ``run_id``, ``triggered``, ``threshold``, ``health`` and
        ``prompt``.

    Raises:
        HTTPException 404: No run found with the given ID for this owner.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id, owner)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")
    datasets = await anyio.to_thread.run_sync(_load_datasets, owner)
    rosbag = next((ds for ds in datasets if ds.id == run_row["rosbagId"]), None)
    detections = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    total_messages = rosbag.messageCount if rosbag else 0
    health = compute_health_summary(detections, total_messages=total_messages)
    score = float(health.get("health_score", 0.0))
    return {
        "run_id": run_id,
        "triggered": should_deep_dive(score, deep_dive_threshold),
        "threshold": deep_dive_threshold,
        "health": health,
        "prompt": build_deep_dive_prompt(health),
    }


@router.get("/analysis/{run_id}/export/windows")
async def export_analysis_windows(
    run_id: str,
    window_sec: float = Query(default=10.0, ge=0.01),
    owner: str = Depends(get_current_user),
) -> StreamingResponse:
    """Stream per-time-window JSONL summaries of a run's bag dataset (per-owner).

    The dataset bags are re-read in streaming mode (never materialized in
    memory) and summarized into one compact JSONL row per ``(topic, window)``:
    message count, expected/actual publish rate, max gap, interval jitter and
    clock drift. This is the LLM-friendly, low-volume export of the
    denormalized stream.

    Args:
        run_id: ID of the analysis run whose dataset should be exported.
        window_sec: Aggregation window width in seconds.
        owner: Current user.

    Returns:
        An NDJSON stream (``application/x-ndjson``).

    Raises:
        HTTPException 404: The run, its dataset or its bag files are not found for this owner.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id, owner)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")
    datasets = await anyio.to_thread.run_sync(_load_datasets, owner)
    dataset = next((ds for ds in datasets if ds.id == run_row["rosbagId"]), None)
    if dataset is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    bag_files = await anyio.to_thread.run_sync(experiment_bag_files, dataset.id, owner)
    if not bag_files:
        raise HTTPException(status_code=404, detail="bag files not found")

    def generate() -> Iterator[str]:
        stream = chain.from_iterable(iter_bag_messages(bag) for bag in bag_files)
        for line in iter_window_jsonl_lines(stream, window_sec=window_sec):
            yield line + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.get("/review", response_model=ReviewListResponse)
async def review_queue(
    status_filter: str = Query(default="pending", alias="status"),
    owner: str = Depends(get_current_user),
) -> ReviewListResponse:
    """Get AI results in the human review queue (per-owner).

    Args:
        status_filter: ``pending`` (default), a specific verdict
            (``approved``/``rejected``/``edited``), or ``all`` for every item.
        owner: Current user.

    Returns:
        ``ReviewListResponse`` with the matching review items and total count.
    """
    rows = await anyio.to_thread.run_sync(
        run_store.list_review_items, None if status_filter == "all" else status_filter, owner
    )
    items = [ReviewItem(**item) for item in rows]
    return ReviewListResponse(items=items, total=len(items))


@router.get("/review/rule-stats", response_model=ReviewRuleStatsResponse)
async def review_rule_statistics(owner: str = Depends(get_current_user)) -> ReviewRuleStatsResponse:
    """Which detection rules reviewers reject most often (per-owner).

    Closes the loop on human review: verdicts were recorded but never read
    back, so nobody could tell which rule to tune. Rows are ordered worst
    accuracy first. Only decided items are counted — a pending item carries no
    judgement, and counting it would make an unreviewed rule look accurate.

    Returns:
        ``ReviewRuleStatsResponse`` with one row per rule kind and the total
        number of decided items behind them.
    """
    rows = await anyio.to_thread.run_sync(run_store.review_rule_stats, owner)
    items = [
        ReviewRuleStat(
            kind=row["kind"],
            topics=row["topics"],
            decided=row["decided"],
            approved=row["approved"],
            rejected=row["rejected"],
            edited=row["edited"],
            accuracy=round(row["accuracy"], 4),
        )
        for row in rows
    ]
    return ReviewRuleStatsResponse(items=items, decided=sum(item.decided for item in items))


@router.get("/review/stats", response_model=ReviewStatsResponse)
async def review_statistics(owner: str = Depends(get_current_user)) -> ReviewStatsResponse:
    """Aggregate human verdicts into agent-accuracy metrics (per-owner).

    ``accuracy`` is approved / reviewed, per run and overall; it is ``None``
    until at least one item has been reviewed. Recall is not reported because
    it would require ground truth for anomalies the agent never raised.

    Returns:
        ``ReviewStatsResponse`` with overall totals and a per-run breakdown.
    """

    def _accuracy(approved: int, reviewed: int) -> float | None:
        return round(approved / reviewed, 4) if reviewed else None

    per_run = await anyio.to_thread.run_sync(run_store.review_stats, owner)
    runs = []
    for row in per_run:
        reviewed = row["approved"] + row["rejected"] + row["edited"]
        runs.append(
            ReviewStatsRun(
                runId=row["runId"],
                rosbagName=row["rosbagName"],
                total=row["total"],
                reviewed=reviewed,
                approved=row["approved"],
                rejected=row["rejected"],
                edited=row["edited"],
                pending=row["pending"],
                accuracy=_accuracy(row["approved"], reviewed),
            )
        )

    approved = sum(run.approved for run in runs)
    rejected = sum(run.rejected for run in runs)
    edited = sum(run.edited for run in runs)
    reviewed = approved + rejected + edited
    return ReviewStatsResponse(
        total=sum(run.total for run in runs),
        reviewed=reviewed,
        approved=approved,
        rejected=rejected,
        edited=edited,
        pending=sum(run.pending for run in runs),
        accuracy=_accuracy(approved, reviewed),
        runs=runs,
    )


@router.post("/analysis/diagnose", response_model=DiagnosticsSummaryResponse)
async def diagnose(request: DiagnosticsRequest) -> DiagnosticsSummaryResponse:
    """Run diagnostics on a ROS message stream.

    Accepts inline data or a ``.mcap`` (JSONL) file path, detects anomalies
    (frequency gaps, silent nodes) against the configured thresholds and logs
    detailed information for each request.

    Args:
        request: Message list and/or ``file_path`` plus optional thresholds.

    Returns:
        ``DiagnosticsSummaryResponse`` with the summary, detections, thresholds
        and analysis logs.

    Raises:
        HTTPException 400/404: ``file_path`` is invalid or does not exist.
    """
    messages = request.messages
    if request.file_path:
        file_path = _resolve_diagnostics_file_path(request.file_path)
        messages = await anyio.to_thread.run_sync(parse_mcap_file, file_path)

    result = await anyio.to_thread.run_sync(detect_anomalies, messages, request.thresholds)
    log_payload = {
        "event": "diagnostics.request",
        "level": "info",
        "message": "Diagnostics request received.",
        "details": {
            "source": "file" if request.file_path else "inline",
            "message_count": len(messages),
            "topic_count": len({msg.get("topic") for msg in messages if "topic" in msg}),
            "node_count": len({msg.get("node") for msg in messages if "node" in msg}),
            "thresholds": result.get("thresholds"),
            "total_detections": result.get("summary", {}).get("total_detections"),
        },
    }
    logger.info("diagnostics.request", extra={"diagnostics": log_payload})
    return DiagnosticsSummaryResponse(**result)


@router.post("/analysis/explain", response_model=DiagnosticsExplanationResponse)
async def explain(
    request: DiagnosticsExplanationRequest,
    _rate_limited: None = Depends(_check_rate_limit),
    _llm_auth: None = Depends(_require_llm_auth),
) -> DiagnosticsExplanationResponse:
    """Explain diagnostics results with the LLM.

    Sends the analysis summary to the LLM to generate a root cause and
    suggested remediation actions.

    Args:
        request: Diagnostics summary to explain.

    Returns:
        ``DiagnosticsExplanationResponse`` with root cause, explanation and
        recommended actions.
    """
    try:
        explanation = await anyio.to_thread.run_sync(explain_diagnostics, request.summary)
    except httpx.HTTPError as exc:
        logger.warning(
            "diagnostics.explain_upstream_failed",
            extra={
                "diagnostics": {
                    "event": "diagnostics.explain_upstream_failed",
                    "level": "warning",
                    "details": {"error_type": type(exc).__name__},
                }
            },
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM provider request failed; verify provider credentials and availability",
        ) from exc
    return DiagnosticsExplanationResponse(**explanation)


@router.get("/hilt/summary/{run_id}", response_model=HiltSummary)
async def get_hilt_summary(
    run_id: str,
    anomaly_id: str = Query(..., description="Anomaly ID to get HILT summary for"),
    owner: str = Depends(get_current_user),
) -> HiltSummary:
    """Get HILT escalation summary for expert review (per-owner).

    Returns the complete iteration history, trigger reasons, and diagnostic
    context for a specific anomaly within a run.

    Args:
        run_id: Analysis run ID.
        anomaly_id: Anomaly ID within the run.
        owner: Current user.

    Returns:
        HiltSummary with all iterations and trigger information.

    Raises:
        HTTPException 404: Run or anomaly not found for this owner.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id, owner)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")

    anomalies = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    anomaly = next((a for a in anomalies if a.get("id") == anomaly_id), None)
    if anomaly is None:
        raise HTTPException(status_code=404, detail="anomaly not found")

    debugger = IterativeDebugger(run_id, anomaly_id, anomaly)
    triggers = await anyio.to_thread.run_sync(debugger.evaluate_triggers, {})
    hilt_payload = await anyio.to_thread.run_sync(debugger.build_hilt_payload, triggers)

    return HiltSummary(**hilt_payload)


@router.post("/hilt/iterate", response_model=AIResultSummary)
async def hilt_iterate(
    run_id: str = Query(..., description="Analysis run ID"),
    anomaly_id: str = Query(..., description="Anomaly ID"),
    test_pass: bool = Query(..., description="Whether engineer test passed"),
    test_comment: str = Query(default="", description="Engineer test comment"),
    _rate_limited: None = Depends(_check_rate_limit),
    owner: str = Depends(get_current_user),
) -> AIResultSummary:
    """Run one iteration of the iterative debug loop (per-owner).

    Records the engineer's test result, evaluates triggers, and returns the
    next LLM suggestion (or escalation payload if triggers fire).

    Args:
        run_id: Analysis run ID.
        anomaly_id: Anomaly ID within the run.
        test_pass: Whether the engineer's test passed.
        test_comment: Optional comment from the engineer.
        owner: Current user.

    Returns:
        Next AIResultSummary from LLM (or canned fallback).

    Raises:
        HTTPException 404: Run or anomaly not found for this owner.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id, owner)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")

    anomalies = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    anomaly = next((a for a in anomalies if a.get("id") == anomaly_id), None)
    if anomaly is None:
        raise HTTPException(status_code=404, detail="anomaly not found")

    debugger = IterativeDebugger(run_id, anomaly_id, anomaly)

    feedback_history = await anyio.to_thread.run_sync(run_store.list_hilt_iterations, run_id, anomaly_id)
    feedback_list = [
        {
            "iteration": fb["iteration"],
            "test_pass": fb["test_pass"],
            "comment": fb["test_comment"],
        }
        for fb in feedback_history
    ]

    ai_result = await anyio.to_thread.run_sync(debugger.suggest, feedback_list)

    llm_output = {
        "root_cause": ai_result.rootCause,
        "explanation": ai_result.explanation,
        "confidence": ai_result.confidence,
    }

    iteration_num = len(feedback_history) + 1
    await anyio.to_thread.run_sync(
        functools.partial(
            debugger.record_test,
            iteration=iteration_num,
            llm_root_cause=ai_result.rootCause,
            llm_actions=ai_result.suggestedFix,
            llm_explanation=ai_result.explanation,
            llm_confidence=ai_result.confidence,
            test_pass=test_pass,
            test_comment=test_comment or None,
        )
    )

    triggers = await anyio.to_thread.run_sync(debugger.evaluate_triggers, llm_output)

    if not debugger.should_continue(iteration_num, triggers):
        hilt_payload = await anyio.to_thread.run_sync(debugger.build_hilt_payload, triggers)
        await anyio.to_thread.run_sync(
            run_store.save_expert_fix,
            run_id,
            anomaly_id,
            "ESCALATED: " + ", ".join(triggers),
            [],
            json.dumps(hilt_payload),
        )
        return ai_result

    return ai_result


@router.post("/hilt/fix/{run_id}", response_model=HiltFixResponse)
async def hilt_fix(
    run_id: str,
    anomaly_id: str = Query(..., description="Anomaly ID"),
    payload: HiltFixRequest = Body(...),
    owner: str = Depends(get_current_user),
) -> HiltFixResponse:
    """Record expert fix for an escalated anomaly (per-owner).

    The expert provides a corrected root cause and actions, which are stored
    and can be used to update the run's AI result.

    Args:
        run_id: Analysis run ID.
        anomaly_id: Anomaly ID within the run.
        payload: Expert's corrected root cause, actions, and notes.
        owner: Current user.

    Returns:
        HiltFixResponse confirming the fix was recorded.

    Raises:
        HTTPException 404: Run or anomaly not found for this owner.
    """
    run_row = await anyio.to_thread.run_sync(run_store.get_run, run_id, owner)
    if run_row is None:
        raise HTTPException(status_code=404, detail="run not found")

    anomalies = await anyio.to_thread.run_sync(run_store.get_run_anomalies, run_id)
    anomaly = next((a for a in anomalies if a.get("id") == anomaly_id), None)
    if anomaly is None:
        raise HTTPException(status_code=404, detail="anomaly not found")

    await anyio.to_thread.run_sync(
        run_store.save_expert_fix,
        run_id,
        anomaly_id,
        payload.corrected_root_cause,
        payload.corrected_actions,
        payload.notes,
    )

    return HiltFixResponse(ok=True, message="Expert fix recorded successfully")


@router.post("/review/{review_id}/decision", response_model=DashboardReviewDecisionResponse)
async def review_decision(
    review_id: str,
    payload: DashboardReviewDecisionRequest,
    owner: str = Depends(get_current_user),
) -> DashboardReviewDecisionResponse:
    """Record a review decision (approve/reject) for an AI result (per-owner).

    Args:
        review_id: ID of the review item to process.
        payload: Verdict, reviewer and notes from the reviewer.
        owner: Current user.

    Returns:
        ``DashboardReviewDecisionResponse`` confirming the recorded decision.

    Raises:
        HTTPException 404: No review item found with the given ID for this owner.
    """
    review_item = await anyio.to_thread.run_sync(run_store.get_review_item, review_id, owner)
    if review_item is None:
        raise HTTPException(status_code=404, detail="review item not found")
    if payload.verdict == "approved":
        ai_results = await anyio.to_thread.run_sync(run_store.get_run_ai_results, review_item["runId"])
        matching = next((r for r in ai_results if r.get("anomalyId") == review_item["anomalyId"]), None)
        # "canned-fallback" is the rule-based guess `_build_ai_results` falls back
        # to when the LLM is unconfigured or a call fails — never approve it as
        # if it were a model verdict. The UI already disables the button for this
        # case; this is the server-side backstop against a client that skips it.
        if matching is not None and matching.get("model") == "canned-fallback":
            raise HTTPException(
                status_code=409,
                detail="cannot approve a rule-based fallback result — the LLM never ran for this conclusion",
            )
    await anyio.to_thread.run_sync(
        run_store.update_review_item,
        review_id,
        payload.verdict,
        payload.reviewer or "reviewer",
        payload.notes,
        owner,
    )
    return DashboardReviewDecisionResponse(
        ok=True,
        verdict=payload.verdict,
        reviewer=payload.reviewer or "reviewer",
        notes=payload.notes,
    )
