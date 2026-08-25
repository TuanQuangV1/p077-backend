"""Seed complete analysis runs and 14-day operational history into SQLite database."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
import random

from src.services import experiments, run_store
from src.services.analysis import run_analysis

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "data" / "runs.db"


def seed_history() -> None:
    print("1. Running real diagnostic analysis on all datasets...")
    datasets = experiments.list_experiments()
    print(f"Found {len(datasets)} datasets in data/: {[d['id'] for d in datasets]}")

    run_ids = []
    for ds in datasets:
        ds_id = ds["id"]
        try:
            res = run_analysis(ds_id, model="gpt-4o-mini")
            run = res["run"]
            run_ids.append(run.id)
            print(f"  ✅ Analyzed {ds_id} -> Run {run.id[:8]} (Anomalies: {run.anomalyCount}, Status: {run.status})")
        except Exception as exc:
            print(f"  ⚠️ Failed analyzing {ds_id}: {exc}")

    print(f"\n2. Back-dating runs across the last 14 days for realistic dashboard trends in {DB_PATH}...")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    now = datetime.now(UTC)
    runs = cursor.execute("SELECT id, started_at FROM runs ORDER BY started_at ASC").fetchall()

    for idx, row in enumerate(runs):
        run_id = row["id"]
        # Distribute over past 14 days
        days_ago = max(0, 13 - (idx * 14 // max(1, len(runs))))
        jitter_hours = (idx * 3) % 24
        jitter_mins = (idx * 17) % 60
        sim_start = now - timedelta(days=days_ago, hours=jitter_hours, minutes=jitter_mins)
        sim_finish = sim_start + timedelta(seconds=random.randint(2, 6))

        cursor.execute(
            "UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?",
            (sim_start.isoformat(), sim_finish.isoformat(), run_id),
        )

    # Approve some review items for human review history
    reviews = cursor.execute("SELECT id FROM review_items").fetchall()
    for idx, r in enumerate(reviews):
        if idx % 2 == 0:
            cursor.execute(
                "UPDATE review_items SET review_status = 'approved', verdict = 'approved', reviewer = 'lead_roboticist', decided_at = ? WHERE id = ?",
                (now.isoformat(), r["id"]),
            )
        elif idx % 3 == 0:
            cursor.execute(
                "UPDATE review_items SET review_status = 'rejected', verdict = 'rejected', reviewer = 'lead_roboticist', notes = 'Expected sensor noise during calibration', decided_at = ? WHERE id = ?",
                (now.isoformat(), r["id"]),
            )

    conn.commit()
    conn.close()

    print(f"✅ Successfully seeded {len(runs)} analysis runs and operational metrics into runs.db!")


if __name__ == "__main__":
    seed_history()
