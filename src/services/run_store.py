"""SQLite-backed persistence for analysis runs, detections and review items.

Replaces the previous module-level in-memory dicts so runs survive restarts
and test isolation is preserved (the store path is configurable via the
``RUN_DB_PATH`` environment variable).
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Concatenate, ParamSpec, TypeVar

if TYPE_CHECKING:
    from collections.abc import Callable

from src.services import perf

logger = logging.getLogger(__name__)

DEFAULT_RUN_DB_PATH = Path("data/runs.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    rosbag_id TEXT NOT NULL,
    rosbag_name TEXT NOT NULL,
    robot_type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL,
    stage TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    anomaly_count INTEGER NOT NULL,
    worst_severity TEXT,
    model TEXT NOT NULL,
    total_latency_ms INTEGER NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    owner TEXT NOT NULL DEFAULT 'admin'
);
CREATE INDEX IF NOT EXISTS idx_runs_owner ON runs(owner);
CREATE TABLE IF NOT EXISTS run_anomalies (
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_run_anomalies_run_id ON run_anomalies(run_id);
CREATE TABLE IF NOT EXISTS run_ai_results (
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_run_ai_results_run_id ON run_ai_results(run_id);
CREATE TABLE IF NOT EXISTS review_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    anomaly_id TEXT NOT NULL,
    review_status TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    explanation TEXT NOT NULL,
    verdict TEXT,
    reviewer TEXT,
    notes TEXT,
    decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_items(review_status);
CREATE TABLE IF NOT EXISTS hilt_iterations (
    run_id TEXT NOT NULL,
    anomaly_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    llm_root_cause TEXT NOT NULL,
    llm_actions TEXT NOT NULL,
    llm_explanation TEXT NOT NULL,
    llm_confidence REAL NOT NULL,
    test_pass INTEGER NOT NULL,
    test_comment TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, anomaly_id, iteration)
);
CREATE TABLE IF NOT EXISTS expert_fixes (
    run_id TEXT NOT NULL,
    anomaly_id TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    actions TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, anomaly_id)
);
CREATE TABLE IF NOT EXISTS auth_users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jwt_blacklist (
    jti TEXT PRIMARY KEY,
    exp REAL NOT NULL
);
"""


def _db_path() -> Path:
    return Path(os.environ.get("RUN_DB_PATH", str(DEFAULT_RUN_DB_PATH)))


_lock = threading.Lock()
_init_state: list[bool] = [False]  # Mutable container — reset when DB path changes
_init_state_db_path: list[str] = [""]


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = perf.open_connection(path, source="runs.db")
    conn.row_factory = sqlite3.Row
    # Enable WAL in production by default when env requests it; also set synchronous=NORMAL for speed
    if os.environ.get("RUN_DB_WAL", "0") == "1":
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
        except sqlite3.Error as exc:
            # A read-only volume or an OS without shared-memory support can
            # reject WAL. Journal mode stays at the default (DELETE) — slower
            # under concurrency but correct — so this is recoverable; surface it.
            logger.warning("run_store: could not enable WAL journal mode: %s", exc)
    return conn


# `ALTER TABLE` on an already-migrated schema is expected to fail with one of
# these — a column that is already there. Anything else is a real migration
# fault and must not be swallowed.
_BENIGN_MIGRATION_ERRORS = ("duplicate column name", "already exists")


def _migrate(conn: sqlite3.Connection) -> None:
    """Bring an existing DB up to the current schema.

    `executescript(_SCHEMA)` creates missing tables/indexes but cannot add a
    column to a table that predates it, so the `owner` column is added here.
    Errors that mean "already applied" are logged at debug and ignored; every
    other `OperationalError` is logged and re-raised, because a migration that
    half-applied and then silently passed is how a schema drifts out of sync
    with the code without anyone noticing.
    """
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_run_anomalies_run_id ON run_anomalies(run_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_run_ai_results_run_id ON run_ai_results(run_id)")

        cols = {row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()}
        if "owner" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN owner TEXT NOT NULL DEFAULT 'admin'")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_owner ON runs(owner)")
        conn.execute("UPDATE runs SET owner = 'admin' WHERE owner IS NULL OR owner = ''")
        conn.commit()
    except sqlite3.OperationalError as exc:
        if any(marker in str(exc).lower() for marker in _BENIGN_MIGRATION_ERRORS):
            logger.debug("run_store: migration step already applied: %s", exc)
            conn.rollback()
            return
        logger.error("run_store: migration failed: %s", exc)
        raise


def _init(conn: sqlite3.Connection) -> None:
    current_path = str(_db_path())
    if not _init_state[0] or _init_state_db_path[0] != current_path:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        _init_state[0] = True
        _init_state_db_path[0] = current_path


_P = ParamSpec("_P")
_R = TypeVar("_R")


def _with_conn(
    func: Callable[Concatenate[sqlite3.Connection, _P], _R],
) -> Callable[_P, _R]:
    def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        with _lock:
            conn = _connect()
            try:
                _init(conn)
                return func(conn, *args, **kwargs)
            finally:
                conn.close()

    return wrapper


@_with_conn
def save_run(conn: sqlite3.Connection, run: dict[str, Any], owner: str = "admin") -> None:
    # owner can be in run dict (analysis) or passed explicitly
    owner_val = run.get("owner") or owner or "admin"
    conn.execute(
        """
        INSERT OR REPLACE INTO runs (
            id, rosbag_id, rosbag_name, robot_type, status, progress, stage,
            started_at, finished_at, anomaly_count, worst_severity, model,
            total_latency_ms, prompt_tokens, completion_tokens, cost_usd, owner
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run["id"],
            run["rosbagId"],
            run["rosbagName"],
            run["robotType"],
            run["status"],
            run["progress"],
            run["stage"],
            run["startedAt"],
            run.get("finishedAt"),
            run["anomalyCount"],
            run.get("worstSeverity"),
            run["model"],
            run["totalLatencyMs"],
            run["promptTokens"],
            run["completionTokens"],
            run["costUsd"],
            owner_val,
        ),
    )
    conn.commit()


@_with_conn
def get_run(conn: sqlite3.Connection, run_id: str, owner: str | None = None) -> dict[str, Any] | None:
    if owner is not None:
        row = conn.execute("SELECT * FROM runs WHERE id = ? AND owner = ?", (run_id, owner)).fetchone()
    else:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    return _run_row_to_dict(row) if row is not None else None


@_with_conn
def list_runs(conn: sqlite3.Connection, owner: str | None = None) -> list[dict[str, Any]]:
    if owner is not None:
        rows = conn.execute("SELECT * FROM runs WHERE owner = ? ORDER BY started_at DESC", (owner,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM runs ORDER BY started_at DESC").fetchall()
    return [_run_row_to_dict(row) for row in rows]


def _run_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    # owner may not exist in legacy rows before migration, default to admin
    try:
        owner_val = row["owner"]
    except (IndexError, KeyError):
        owner_val = "admin"
    return {
        "id": row["id"],
        "rosbagId": row["rosbag_id"],
        "rosbagName": row["rosbag_name"],
        "robotType": row["robot_type"],
        "status": row["status"],
        "progress": row["progress"],
        "stage": row["stage"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "anomalyCount": row["anomaly_count"],
        "worstSeverity": row["worst_severity"],
        "model": row["model"],
        "totalLatencyMs": row["total_latency_ms"],
        "promptTokens": row["prompt_tokens"],
        "completionTokens": row["completion_tokens"],
        "costUsd": row["cost_usd"],
        "owner": owner_val or "admin",
    }


@_with_conn
def save_run_anomalies(conn: sqlite3.Connection, run_id: str, detections: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM run_anomalies WHERE run_id = ?", (run_id,))
    conn.executemany(
        "INSERT INTO run_anomalies (run_id, idx, payload) VALUES (?, ?, ?)",
        [(run_id, idx, json.dumps(detection)) for idx, detection in enumerate(detections)],
    )
    conn.commit()


@_with_conn
def get_run_anomalies(conn: sqlite3.Connection, run_id: str) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT payload FROM run_anomalies WHERE run_id = ? ORDER BY idx", (run_id,)).fetchall()
    return [json.loads(row["payload"]) for row in rows]


def _runs_anomalies(conn: sqlite3.Connection, run_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Body of :func:`get_runs_anomalies`, callable while already holding a connection.

    `_with_conn` takes a plain (non-reentrant) lock, so a decorated function
    calling another decorated function deadlocks. Callers that already have a
    connection use this directly.
    """
    if not run_ids:
        return {}
    placeholders = ",".join("?" * len(run_ids))
    rows = conn.execute(
        f"SELECT run_id, idx, payload FROM run_anomalies WHERE run_id IN ({placeholders}) ORDER BY idx",
        tuple(run_ids),
    ).fetchall()
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[row["run_id"]].append(json.loads(row["payload"]))
    return grouped


@_with_conn
def get_runs_anomalies(conn: sqlite3.Connection, run_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Fetch anomalies for many runs in a single query (avoids N+1).

    Args:
        run_ids: Run ids to load anomalies for.

    Returns:
        Mapping of ``run_id -> [anomaly payloads]``, ordered by ``idx`` within
        each run. Runs without anomalies are absent from the mapping.
    """
    return _runs_anomalies(conn, run_ids)


@_with_conn
def save_run_ai_results(conn: sqlite3.Connection, run_id: str, results: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM run_ai_results WHERE run_id = ?", (run_id,))
    conn.executemany(
        "INSERT INTO run_ai_results (run_id, idx, payload) VALUES (?, ?, ?)",
        [(run_id, idx, json.dumps(result)) for idx, result in enumerate(results)],
    )
    conn.commit()


@_with_conn
def get_run_ai_results(conn: sqlite3.Connection, run_id: str) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT payload FROM run_ai_results WHERE run_id = ? ORDER BY idx", (run_id,)).fetchall()
    return [json.loads(row["payload"]) for row in rows]


@_with_conn
def save_review_items(conn: sqlite3.Connection, items: list[dict[str, Any]]) -> None:
    conn.executemany(
        """
        INSERT OR REPLACE INTO review_items (
            id, run_id, anomaly_id, review_status, root_cause, explanation
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                item["id"],
                item["runId"],
                item["anomalyId"],
                item["reviewStatus"],
                item["rootCause"],
                item["explanation"],
            )
            for item in items
        ],
    )
    conn.commit()


@_with_conn
def list_review_items(
    conn: sqlite3.Connection, status: str | None = None, owner: str | None = None
) -> list[dict[str, Any]]:
    if owner is not None:
        if owner == "admin":
            # Admin sees orphaned review items (no run) as well for backwards compat with tests
            if status is None:
                rows = conn.execute(
                    """
                    SELECT ri.* FROM review_items ri
                    LEFT JOIN runs r ON r.id = ri.run_id
                    WHERE r.owner = ? OR r.owner IS NULL
                    ORDER BY ri.id
                    """,
                    (owner,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT ri.* FROM review_items ri
                    LEFT JOIN runs r ON r.id = ri.run_id
                    WHERE ri.review_status = ? AND (r.owner = ? OR r.owner IS NULL)
                    ORDER BY ri.id
                    """,
                    (status, owner),
                ).fetchall()
        elif status is None:
            rows = conn.execute(
                """
                    SELECT ri.* FROM review_items ri
                    JOIN runs r ON r.id = ri.run_id
                    WHERE r.owner = ?
                    ORDER BY ri.id
                    """,
                (owner,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                    SELECT ri.* FROM review_items ri
                    JOIN runs r ON r.id = ri.run_id
                    WHERE ri.review_status = ? AND r.owner = ?
                    ORDER BY ri.id
                    """,
                (status, owner),
            ).fetchall()
    elif status is None:
        rows = conn.execute("SELECT * FROM review_items ORDER BY id").fetchall()
    else:
        rows = conn.execute("SELECT * FROM review_items WHERE review_status = ? ORDER BY id", (status,)).fetchall()
    return [_review_row_to_dict(row) for row in rows]


@_with_conn
def get_review_item(
    conn: sqlite3.Connection, review_id: str, owner: str | None = None
) -> dict[str, Any] | None:
    if owner is not None:
        if owner == "admin":
            row = conn.execute(
                """
                SELECT ri.* FROM review_items ri
                LEFT JOIN runs r ON r.id = ri.run_id
                WHERE ri.id = ? AND (r.owner = ? OR r.owner IS NULL)
                """,
                (review_id, owner),
            ).fetchone()
        else:
            row = conn.execute(
                """
                SELECT ri.* FROM review_items ri
                JOIN runs r ON r.id = ri.run_id
                WHERE ri.id = ? AND r.owner = ?
                """,
                (review_id, owner),
            ).fetchone()
    else:
        row = conn.execute("SELECT * FROM review_items WHERE id = ?", (review_id,)).fetchone()
    return _review_row_to_dict(row) if row is not None else None


@_with_conn
def update_review_item(
    conn: sqlite3.Connection,
    review_id: str,
    verdict: str,
    reviewer: str,
    notes: str | None,
    owner: str | None = None,
) -> None:
    if owner is not None:
        if owner == "admin":
            target = conn.execute(
                """
                SELECT ri.run_id, ri.anomaly_id FROM review_items ri
                LEFT JOIN runs r ON r.id = ri.run_id
                WHERE ri.id = ? AND (r.owner = ? OR r.owner IS NULL)
                """,
                (review_id, owner),
            ).fetchone()
        else:
            target = conn.execute(
                """
                SELECT ri.run_id, ri.anomaly_id FROM review_items ri
                JOIN runs r ON r.id = ri.run_id
                WHERE ri.id = ? AND r.owner = ?
                """,
                (review_id, owner),
            ).fetchone()
        if target is None:
            return
    else:
        target = conn.execute(
            "SELECT run_id, anomaly_id FROM review_items WHERE id = ?", (review_id,)
        ).fetchone()
    decided_at = _now_iso()
    conn.execute(
        """
        UPDATE review_items
        SET review_status = ?, verdict = ?, reviewer = ?, notes = ?, decided_at = ?
        WHERE id = ?
        """,
        (verdict, verdict, reviewer, notes, decided_at, review_id),
    )
    if target is not None:
        _sync_ai_result_review_status(
            conn, target["run_id"], target["anomaly_id"], verdict, reviewer, notes, decided_at
        )
    conn.commit()


def _sync_ai_result_review_status(
    conn: sqlite3.Connection,
    run_id: str,
    anomaly_id: str,
    review_status: str,
    reviewer: str,
    notes: str | None,
    decided_at: str,
) -> None:
    """Mirror a review decision onto the matching row in run_ai_results.

    review_items and run_ai_results are separate tables (one row of JSON per
    AI result), so a review decision only reached review_items until now,
    leaving GET /analysis/{run_id} stuck showing "pending" forever.
    """
    rows = conn.execute(
        "SELECT idx, payload FROM run_ai_results WHERE run_id = ?", (run_id,)
    ).fetchall()
    for row in rows:
        payload = json.loads(row["payload"])
        if payload.get("anomalyId") == anomaly_id:
            payload["reviewStatus"] = review_status
            payload["reviewer"] = reviewer
            payload["reviewerNote"] = notes
            payload["reviewedAt"] = decided_at
            conn.execute(
                "UPDATE run_ai_results SET payload = ? WHERE run_id = ? AND idx = ?",
                (json.dumps(payload), run_id, row["idx"]),
            )
            break


@_with_conn
def review_rule_stats(conn: sqlite3.Connection, owner: str | None = None) -> list[dict[str, Any]]:
    """Verdict tallies grouped by the detection rule the conclusion was about.

    Reviewers already say which AI conclusions were wrong, but nothing read
    that back, so the system could not get better at the rules it is worst at.
    Joining each decided review item to its anomaly's ``kind`` answers "which
    rule do reviewers reject most often" — the input for deciding which
    threshold to hand-tune next.

    Only decided items count: a pending item carries no judgement, and folding
    it in would make a rule nobody has reviewed yet look accurate.

    Returns:
        One row per rule kind, worst accuracy first, each with ``kind``,
        ``topics`` (distinct topics seen for that rule), ``decided``,
        ``approved``, ``rejected``, ``edited`` and ``accuracy`` (approved over
        decided, 0.0-1.0).
    """
    query = """
        SELECT r.run_id AS run_id, r.anomaly_id AS anomaly_id, r.review_status AS review_status
        FROM review_items r
        LEFT JOIN runs ON runs.id = r.run_id
        WHERE r.review_status IN ('approved', 'rejected', 'edited')
    """
    params: tuple[str, ...] = ()
    if owner is not None:
        # Same visibility rule as `list_review_items`, so this never reports on
        # a smaller set than the queue the reviewer actually worked through:
        # admin also sees review items whose run row is gone.
        query += " AND (runs.owner = ? OR runs.owner IS NULL)" if owner == "admin" else " AND runs.owner = ?"
        params = (owner,)
    rows = conn.execute(query, params).fetchall()
    if not rows:
        return []

    anomalies = _runs_anomalies(conn, sorted({row["run_id"] for row in rows}))
    kind_by_key = {
        (run_id, str(anomaly.get("id", ""))): anomaly
        for run_id, run_anomalies in anomalies.items()
        for anomaly in run_anomalies
    }

    tallies: dict[str, dict[str, Any]] = {}
    for row in rows:
        anomaly = kind_by_key.get((row["run_id"], row["anomaly_id"]))
        if anomaly is None:
            # The run's anomalies were overwritten by a re-analysis while its
            # review items survived; the verdict no longer has a rule to blame.
            continue
        kind = str(anomaly.get("kind", "unknown"))
        tally = tallies.setdefault(
            kind,
            {"kind": kind, "topics": set(), "decided": 0, "approved": 0, "rejected": 0, "edited": 0},
        )
        # Stored anomalies are the raw detections, which carry a single `topic`
        # — the plural `topics` only appears later in the API response shape.
        tally["topics"].add(str(anomaly.get("topic", "")))
        tally["decided"] += 1
        tally[row["review_status"]] += 1

    return sorted(
        (
            {**tally, "topics": sorted(tally["topics"]), "accuracy": tally["approved"] / tally["decided"]}
            for tally in tallies.values()
        ),
        key=lambda entry: (entry["accuracy"], -entry["decided"]),
    )


@_with_conn
def review_stats(conn: sqlite3.Connection, owner: str | None = None) -> list[dict[str, Any]]:
    """Per-run verdict tallies for the agent-accuracy report."""
    if owner is not None:
        rows = conn.execute(
            """
            SELECT r.run_id AS run_id,
                   COALESCE(runs.rosbag_name, r.run_id) AS rosbag_name,
                   COUNT(*) AS total,
                   SUM(CASE WHEN r.review_status = 'approved' THEN 1 ELSE 0 END) AS approved,
                   SUM(CASE WHEN r.review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                   SUM(CASE WHEN r.review_status = 'edited' THEN 1 ELSE 0 END) AS edited,
                   SUM(CASE WHEN r.review_status = 'pending' THEN 1 ELSE 0 END) AS pending
            FROM review_items r
            LEFT JOIN runs ON runs.id = r.run_id
            WHERE runs.owner = ?
            GROUP BY r.run_id
            ORDER BY r.run_id
            """,
            (owner,),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT r.run_id AS run_id,
                   COALESCE(runs.rosbag_name, r.run_id) AS rosbag_name,
                   COUNT(*) AS total,
                   SUM(CASE WHEN r.review_status = 'approved' THEN 1 ELSE 0 END) AS approved,
                   SUM(CASE WHEN r.review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                   SUM(CASE WHEN r.review_status = 'edited' THEN 1 ELSE 0 END) AS edited,
                   SUM(CASE WHEN r.review_status = 'pending' THEN 1 ELSE 0 END) AS pending
            FROM review_items r
            LEFT JOIN runs ON runs.id = r.run_id
            GROUP BY r.run_id
            ORDER BY r.run_id
            """
        ).fetchall()
    return [
        {
            "runId": row["run_id"],
            "rosbagName": row["rosbag_name"],
            "total": row["total"],
            "approved": row["approved"],
            "rejected": row["rejected"],
            "edited": row["edited"],
            "pending": row["pending"],
        }
        for row in rows
    ]


def _review_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "runId": row["run_id"],
        "anomalyId": row["anomaly_id"],
        "reviewStatus": row["review_status"],
        "rootCause": row["root_cause"],
        "explanation": row["explanation"],
        "verdict": row["verdict"],
        "reviewer": row["reviewer"],
        "notes": row["notes"],
        "decidedAt": row["decided_at"],
    }


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@_with_conn
def save_hilt_iteration(
    conn: sqlite3.Connection,
    run_id: str,
    anomaly_id: str,
    iteration: int,
    llm_root_cause: str,
    llm_actions: list[str],
    llm_explanation: str,
    llm_confidence: float,
    test_pass: int,
    test_comment: str | None,
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO hilt_iterations (
            run_id, anomaly_id, iteration, llm_root_cause, llm_actions,
            llm_explanation, llm_confidence, test_pass, test_comment, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            anomaly_id,
            iteration,
            llm_root_cause,
            json.dumps(llm_actions),
            llm_explanation,
            llm_confidence,
            test_pass,
            test_comment,
            _now_iso(),
        ),
    )
    conn.commit()


@_with_conn
def list_hilt_iterations(conn: sqlite3.Connection, run_id: str, anomaly_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT run_id, anomaly_id, iteration, llm_root_cause, llm_actions,
               llm_explanation, llm_confidence, test_pass, test_comment, created_at
        FROM hilt_iterations
        WHERE run_id = ? AND anomaly_id = ?
        ORDER BY iteration
        """,
        (run_id, anomaly_id),
    ).fetchall()
    return [
        {
            "run_id": row["run_id"],
            "anomaly_id": row["anomaly_id"],
            "iteration": row["iteration"],
            "llm_root_cause": row["llm_root_cause"],
            "llm_actions": json.loads(row["llm_actions"]) if row["llm_actions"] else [],
            "llm_explanation": row["llm_explanation"],
            "llm_confidence": row["llm_confidence"],
            "test_pass": bool(row["test_pass"]),
            "test_comment": row["test_comment"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]


@_with_conn
def get_hilt_iteration(
    conn: sqlite3.Connection, run_id: str, anomaly_id: str, iteration: int
) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT run_id, anomaly_id, iteration, llm_root_cause, llm_actions,
               llm_explanation, llm_confidence, test_pass, test_comment, created_at
        FROM hilt_iterations
        WHERE run_id = ? AND anomaly_id = ? AND iteration = ?
        """,
        (run_id, anomaly_id, iteration),
    ).fetchone()
    if row is None:
        return None
    return {
        "run_id": row["run_id"],
        "anomaly_id": row["anomaly_id"],
        "iteration": row["iteration"],
        "llm_root_cause": row["llm_root_cause"],
        "llm_actions": json.loads(row["llm_actions"]) if row["llm_actions"] else [],
        "llm_explanation": row["llm_explanation"],
        "llm_confidence": row["llm_confidence"],
        "test_pass": bool(row["test_pass"]),
        "test_comment": row["test_comment"],
        "created_at": row["created_at"],
    }


@_with_conn
def save_expert_fix(
    conn: sqlite3.Connection,
    run_id: str,
    anomaly_id: str,
    root_cause: str,
    actions: list[str],
    notes: str | None,
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO expert_fixes (
            run_id, anomaly_id, root_cause, actions, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (run_id, anomaly_id, root_cause, json.dumps(actions), notes, _now_iso()),
    )
    conn.commit()


@_with_conn
def get_expert_fix(conn: sqlite3.Connection, run_id: str, anomaly_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM expert_fixes WHERE run_id = ? AND anomaly_id = ?",
        (run_id, anomaly_id),
    ).fetchone()
    if row is None:
        return None
    return {
        "run_id": row["run_id"],
        "anomaly_id": row["anomaly_id"],
        "root_cause": row["root_cause"],
        "actions": json.loads(row["actions"]) if row["actions"] else [],
        "notes": row["notes"],
        "created_at": row["created_at"],
    }


# --- Auth persistence (see src.services.auth) -------------------------------
# Signup users and the JWT logout blacklist used to be module-level dicts, so
# every registered account and every revoked token vanished on restart or was
# fragmented across processes. They live in the same SQLite file as everything
# else now; the rate limiter stays in-memory (single-instance only).


@_with_conn
def get_auth_user(conn: sqlite3.Connection, username: str) -> dict[str, str] | None:
    row = conn.execute(
        "SELECT username, password_hash, created_at FROM auth_users WHERE username = ?",
        (username,),
    ).fetchone()
    if row is None:
        return None
    return {"username": row["username"], "password_hash": row["password_hash"], "created_at": row["created_at"]}


@_with_conn
def create_auth_user(conn: sqlite3.Connection, username: str, password_hash: str) -> bool:
    """Insert a new user. Returns False if the username is already taken."""
    try:
        conn.execute(
            "INSERT INTO auth_users (username, password_hash, created_at) VALUES (?, ?, ?)",
            (username, password_hash, _now_iso()),
        )
    except sqlite3.IntegrityError:
        return False
    conn.commit()
    return True


@_with_conn
def clear_auth_users(conn: sqlite3.Connection) -> None:  # for tests
    conn.execute("DELETE FROM auth_users")
    conn.commit()


@_with_conn
def blacklist_jti(conn: sqlite3.Connection, jti: str, exp: float) -> None:
    conn.execute("INSERT OR REPLACE INTO jwt_blacklist (jti, exp) VALUES (?, ?)", (jti, exp))
    conn.execute("DELETE FROM jwt_blacklist WHERE exp < ?", (time.time(),))
    conn.commit()


@_with_conn
def is_jti_blacklisted(conn: sqlite3.Connection, jti: str) -> bool:
    # An expired row is not "blacklisted" — the token is already invalid on its
    # own `exp`. It is purged on the next `blacklist_jti` write.
    row = conn.execute(
        "SELECT 1 FROM jwt_blacklist WHERE jti = ? AND exp > ?",
        (jti, time.time()),
    ).fetchone()
    return row is not None


@_with_conn
def clear_jwt_blacklist(conn: sqlite3.Connection) -> None:  # for tests
    conn.execute("DELETE FROM jwt_blacklist")
    conn.commit()
