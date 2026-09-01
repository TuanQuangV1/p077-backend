import logging
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from src.api.routes import protected_router, public_router
from src.config import get_settings
from src.services import perf, run_store

logger = logging.getLogger(__name__)

_SLOW_REQUEST_MS = float(os.environ.get("PERF_SLOW_REQUEST_MS", "1000"))


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    print(f"Starting {settings.app_name} in {settings.app_env} mode")
    yield
    print("Shutting down...")


app = FastAPI(
    title="AI20K Agent",
    description="RAV-13 rosbag diagnostics API (manual tool-calling over OpenAI-compatible endpoints)",
    version="1.0.0",
    lifespan=lifespan,
)

settings = get_settings()
# Root handler so app/perf logs are visible under uvicorn (its default config
# only wires up the uvicorn.* loggers).
logging.basicConfig(level=logging.getLevelName(settings.log_level))

_cors_origins = settings.cors_origin_list
if "*" in _cors_origins:
    # With allow_credentials the wildcard does not become a literal `*`
    # response header — Starlette echoes the request Origin instead — so `*`
    # still lets any site make authenticated calls. Refuse it where it matters.
    if settings.app_env == "production":
        raise RuntimeError(
            "CORS_ORIGINS must be an explicit allowlist in production, not '*'. "
            "Set it to the frontend origin(s), comma-separated."
        )
    if settings.app_env == "staging":
        logger.error("CORS_ORIGINS is '*' in staging — every origin is trusted; set an explicit allowlist")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(public_router, prefix="/api/v1")
app.include_router(protected_router, prefix="/api/v1")


@app.middleware("http")
async def measure_request(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    """Log per-request timing and DB query counters (performance scaffolding)."""
    started = time.perf_counter()
    metrics, token = perf.begin_request()
    status_code: int | None = None
    try:
        response = await call_next(request)
        status_code = getattr(response, "status_code", None)
        return response
    finally:
        duration_ms = (time.perf_counter() - started) * 1000
        perf.end_request(token)
        details = {
            "event": "perf.request",
            "level": "info",
            "method": request.method,
            "path": request.url.path,
            "status": status_code,
            "durationMs": round(duration_ms, 2),
            "queries": metrics["queries"],
            "dbMs": round(metrics["db_ms"], 2),
            "slowQueries": len(metrics["slow_queries"]),
        }
        message = (
            f"perf.request {request.method} {request.url.path} status={status_code} "
            f"durationMs={details['durationMs']} queries={metrics['queries']} "
            f"dbMs={details['dbMs']} slowQueries={details['slowQueries']}"
        )
        if duration_ms >= _SLOW_REQUEST_MS:
            details["level"] = "warning"
            logger.warning(message, extra={"diagnostics": details})
        else:
            logger.info(message, extra={"diagnostics": details})


@app.get("/health")
async def health() -> dict[str, str]:
    # Light liveness check that also verifies DB is reachable; never throws 500 for health probes
    try:
        await anyio.to_thread.run_sync(lambda: run_store.list_runs(None)[:1])
    except Exception:
        # DB unreachable still returns 200 but with degraded status so orchestrator can decide
        return {"status": "degraded", "env": settings.app_env}
    return {"status": "ok", "env": settings.app_env}
