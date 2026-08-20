"""Per-request performance instrumentation (measurement scaffolding).

Everything here only measures and logs timing — it never changes behaviour:

- :func:`open_connection` opens ``sqlite3`` connections as a timed subclass so
  every statement is measured; slow statements are logged and per-request
  counters (query count, cumulative DB time, slow queries) are accumulated for
  N+1 detection.
- :func:`begin_request` / :func:`end_request` bind those counters to the
  current request via a ``ContextVar`` (propagated into worker threads by
  ``anyio.to_thread.run_sync``).
- :func:`timed_phase` logs the wall time of a pipeline stage.

Tuning knobs (env vars):

- ``PERF_SLOW_QUERY_MS`` (default 100): queries slower than this are logged.
- ``PERF_SLOW_REQUEST_MS`` (default 1000): requests slower than this are
  logged at WARNING level by the HTTP middleware in :mod:`src.main`.
"""

from __future__ import annotations

import contextvars
import logging
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

logger = logging.getLogger(__name__)

SLOW_QUERY_MS = float(os.environ.get("PERF_SLOW_QUERY_MS", "100"))

_RequestMetrics = dict[str, Any]

_REQUEST_METRICS: contextvars.ContextVar[_RequestMetrics | None] = contextvars.ContextVar(
    "perf_request_metrics", default=None
)


class _TimedConnection(sqlite3.Connection):
    """Connection subclass that times every statement against its source label."""

    _perf_source = "sqlite"

    def execute(self, sql: str, parameters: Any = ()) -> sqlite3.Cursor:
        started = time.perf_counter()
        try:
            return super().execute(sql, parameters)
        finally:
            record_sqlite_call(self._perf_source, sql, (time.perf_counter() - started) * 1000)

    def executemany(self, sql: str, seq_of_parameters: Any = ()) -> sqlite3.Cursor:
        started = time.perf_counter()
        try:
            return super().executemany(sql, seq_of_parameters)
        finally:
            record_sqlite_call(self._perf_source, sql, (time.perf_counter() - started) * 1000)

    def executescript(self, sql_script: str) -> sqlite3.Cursor:
        started = time.perf_counter()
        try:
            return super().executescript(sql_script)
        finally:
            record_sqlite_call(self._perf_source, sql_script, (time.perf_counter() - started) * 1000)


def open_connection(
    database: str | Path,
    *,
    source: str,
    **kwargs: Any,
) -> sqlite3.Connection:
    """Open a SQLite connection whose statements are all timed.

    ``source`` labels the connection in logs / per-request counters (e.g.
    ``"runs.db"`` or ``"bag.db3:<name>"``). Extra kwargs (``uri=True``,
    ``timeout``, ...) are forwarded to :func:`sqlite3.connect`.
    """
    conn_type = cast(
        "type[_TimedConnection]",
        type("TimedSqliteConnection", (_TimedConnection,), {"_perf_source": source}),
    )
    return sqlite3.connect(database, factory=conn_type, **kwargs)


def begin_request() -> tuple[_RequestMetrics, contextvars.Token[_RequestMetrics | None]]:
    """Open a fresh per-request metrics bucket and bind it to the context.

    Call from HTTP middleware and reset with :func:`end_request` afterwards.
    """
    metrics: _RequestMetrics = {
        "queries": 0,
        "db_ms": 0.0,
        "slow_queries": [],
    }
    token = _REQUEST_METRICS.set(metrics)
    return metrics, token


def end_request(token: contextvars.Token[_RequestMetrics | None]) -> None:
    """Release the metrics bucket bound by :func:`begin_request`."""
    _REQUEST_METRICS.reset(token)


def record_sqlite_call(source: str, sql: str, duration_ms: float) -> None:
    """Count a SQLite statement and log it when it exceeds the slow threshold."""
    metrics = _REQUEST_METRICS.get()
    if metrics is not None:
        metrics["queries"] += 1
        metrics["db_ms"] += duration_ms
    if duration_ms >= SLOW_QUERY_MS:
        one_line = " ".join(str(sql).split())
        logger.warning(
            f"perf.slow_query source={source} durationMs={round(duration_ms, 2)} sql={one_line[:500]}",
            extra={
                "diagnostics": {
                    "event": "perf.slow_query",
                    "level": "warning",
                    "source": source,
                    "durationMs": round(duration_ms, 2),
                    "sql": one_line[:500],
                }
            },
        )
        if metrics is not None:
            metrics["slow_queries"].append(
                {"source": source, "durationMs": round(duration_ms, 2), "sql": one_line[:500]}
            )


@contextmanager
def timed_phase(name: str, details: dict[str, Any] | None = None) -> Iterator[None]:
    """Log the wall-clock duration of a named pipeline stage at INFO level."""
    started = time.perf_counter()
    try:
        yield
    finally:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        payload: dict[str, Any] = {
            "event": f"perf.phase.{name}",
            "level": "info",
            "durationMs": duration_ms,
        }
        if details:
            payload["details"] = details
        logger.info(f"perf.phase.{name} durationMs={duration_ms}", extra={"diagnostics": payload})
