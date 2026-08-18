"""SQLite-backed persistence for analysis runs, detections and review items.

Replaces the previous module-level in-memory dicts so runs survive restarts
and test isolation is preserved (the store path is configurable via the
``RUN_DB_PATH`` environment variable).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Concatenate, ParamSpec, TypeVar

if TYPE_CHECKING:
    from collections.abc import Callable

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
    cost_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS run_anomalies (
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, idx)
);
CREATE TABLE IF NOT EXISTS run_ai_results (
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, idx)
);
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
"""


def _db_path() -> Path:
    return Path(os.environ.get("RUN_DB_PATH", str(DEFAULT_RUN_DB_PATH)))


_lock = threading.Lock()
_init_state: list[bool] = [False]  # Mutable container — reset when DB path changes
_init_state_db_path: list[str] = [""]


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _init(conn: sqlite3.Connection) -> None:
    current_path = str(_db_path())
    if not _init_state[0] or _init_state_db_path[0] != current_path:
        conn.executescript(_SCHEMA)
        conn.commit()
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
def save_run(conn: sqlite3.Connection, run: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO runs (
            id, rosbag_id, rosbag_name, robot_type, status, progress, stage,
            started_at, finished_at, anomaly_count, worst_severity, model,
            total_latency_ms, prompt_tokens, completion_tokens, cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        ),
    )
    conn.commit()


@_with_conn
def get_run(conn: sqlite3.Connection, run_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    return _run_row_to_dict(row) if row is not None else None


@_with_conn
def list_runs(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM runs ORDER BY started_at DESC").fetchall()
    return [_run_row_to_dict(row) for row in rows]


def _run_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
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
def list_review_items(conn: sqlite3.Connection, status: str | None = None) -> list[dict[str, Any]]:
    if status is None:
        rows = conn.execute("SELECT * FROM review_items ORDER BY id").fetchall()
    else:
        rows = conn.execute("SELECT * FROM review_items WHERE review_status = ? ORDER BY id", (status,)).fetchall()
    return [_review_row_to_dict(row) for row in rows]


@_with_conn
def get_review_item(conn: sqlite3.Connection, review_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM review_items WHERE id = ?", (review_id,)).fetchone()
    return _review_row_to_dict(row) if row is not None else None


@_with_conn
def update_review_item(
    conn: sqlite3.Connection,
    review_id: str,
    verdict: str,
    reviewer: str,
    notes: str | None,
) -> None:
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
def review_stats(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Per-run verdict tallies for the agent-accuracy report."""
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
