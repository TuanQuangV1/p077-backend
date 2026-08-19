"""EXPLAIN QUERY PLAN + wall-clock timing for the store's hot queries.

Usage:
    python scripts/perf/explain_queries.py [--db data/runs.db]

Runs EXPLAIN QUERY PLAN and a 3x timed execution of each query the API hits
most often, plus PRAGMA journal_mode / index inventory. This is the SQLite
stand-in for "slow query log + EXPLAIN ANALYZE".
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

_SAMPLE_RUN_ID = "run_test_minimal"
_SAMPLE_RUN_IDS = ["run_test_minimal", "run_F1_01_0", "run_C_02_0", "run_healthy_01_0", "run_F1_02_0"]

_QUERIES: list[tuple[str, str, tuple[object, ...]]] = [
    ("list_runs", "SELECT * FROM runs ORDER BY started_at DESC", ()),
    (
        "get_run_anomalies",
        "SELECT payload FROM run_anomalies WHERE run_id = ? ORDER BY idx",
        (_SAMPLE_RUN_ID,),
    ),
    (
        "get_runs_anomalies (5 runs, N+1 fix)",
        "SELECT run_id, idx, payload FROM run_anomalies WHERE run_id IN (?, ?, ?, ?, ?) ORDER BY idx",
        tuple(_SAMPLE_RUN_IDS),
    ),
    (
        "list_review_items(status=pending)",
        "SELECT * FROM review_items WHERE review_status = ? ORDER BY id",
        ("pending",),
    ),
    (
        "review_stats (join + group by)",
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
        """,
        (),
    ),
]


def main() -> None:
    parser = argparse.ArgumentParser(description="EXPLAIN QUERY PLAN + timing for hot queries.")
    parser.add_argument("--db", default=str(REPO_ROOT / "data" / "runs.db"))
    args = parser.parse_args()

    path = Path(args.db)
    if not path.exists():
        sys.exit(f"database not found: {path} (run the server once to create it)")
    conn = sqlite3.connect(path)

    print(f"== PRAGMA journal_mode: {conn.execute('PRAGMA journal_mode').fetchone()[0]}")
    print("\n== Indexes")
    for row in conn.execute("SELECT name, tbl_name FROM sqlite_master WHERE type='index' ORDER BY name"):
        print(f"  {row[0]}  ({row[1]})")
    for table in ("runs", "run_anomalies", "run_ai_results", "review_items"):
        print(f"  rows[{table}] = {conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]}")

    for name, sql, params in _QUERIES:
        print(f"\n== {name}")
        print("  EXPLAIN QUERY PLAN:")
        for row in conn.execute(f"EXPLAIN QUERY PLAN {sql}", params):
            print(f"    {row[0]} {row[1]} {row[2]} {row[3]}")
        samples = []
        for _ in range(3):
            started = time.perf_counter()
            conn.execute(sql, params).fetchall()
            samples.append((time.perf_counter() - started) * 1000)
        print(f"  wall time x3: {[round(s, 2) for s in samples]} ms")

    conn.close()


if __name__ == "__main__":
    main()
