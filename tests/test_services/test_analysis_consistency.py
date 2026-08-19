"""Consistency tests: running the same bag repeatedly must yield identical conclusions.

Verified at both layers:
- service: :func:`src.services.analysis.run_analysis`
- API: ``POST /api/v1/analysis`` + ``GET /api/v1/analysis/{id}``

Volatile timing fields (``startedAt``, ``finishedAt``, ``totalLatencyMs``,
``latencyMs``) are excluded from the comparisons because they are expected to
differ between runs; everything that drives the conclusion must not.
"""

import sqlite3
from pathlib import Path

import pytest
import yaml  # type: ignore[import-untyped]

from src.services import run_store
from src.services.analysis import run_analysis

_BAG_STAMPS_NS = [1_000_000_000, 1_100_000_000, 1_200_000_000, 3_200_000_000, 3_300_000_000]
_REPEATS = 3


def _create_sqlite_bag(
    folder: Path,
    stamps_ns: list[int],
    topic: str = "/scan",
    msg_type: str = "sensor_msgs/msg/LaserScan",
) -> None:
    """Create a minimal rosbag2-style SQLite bag under `folder`."""
    conn = sqlite3.connect(folder / "bag.db3")
    conn.execute(
        "CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT, type TEXT, serialization_format TEXT, offered_qos_profiles TEXT)"
    )
    conn.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER, timestamp INTEGER, data BLOB)")
    conn.execute("INSERT INTO topics VALUES (1, ?, ?, 'cdr', '{}')", (topic, msg_type))
    conn.executemany("INSERT INTO messages(topic_id, timestamp) VALUES (1, ?)", [(t,) for t in stamps_ns])
    conn.commit()
    conn.close()


def _metadata_yaml(stamps_ns: list[int], topic: str = "/scan", msg_type: str = "sensor_msgs/msg/LaserScan") -> str:
    """Build a metadata.yaml that matches a bag created with the same inputs."""
    start_ns = min(stamps_ns) if stamps_ns else 0
    duration_ns = max(stamps_ns) - start_ns if stamps_ns else 0
    meta = {
        "rosbag2_bagfile_information": {
            "version": 4,
            "duration": {"nanoseconds": duration_ns},
            "starting_time": {"nanoseconds_since_epoch": start_ns},
            "message_count": len(stamps_ns),
            "topics_with_message_count": [
                {
                    "topic_metadata": {
                        "name": topic,
                        "type": msg_type,
                        "serialization_format": "cdr",
                        "offered_qos_profiles": {},
                    },
                    "message_count": len(stamps_ns),
                }
            ],
        }
    }
    return str(yaml.safe_dump(meta, sort_keys=False))


def _write_dataset(
    folder: Path,
    stamps_ns: list[int],
    topic: str = "/scan",
    msg_type: str = "sensor_msgs/msg/LaserScan",
) -> None:
    """Create a dataset folder with a SQLite bag and matching metadata.yaml."""
    folder.mkdir()
    _create_sqlite_bag(folder, stamps_ns, topic=topic, msg_type=msg_type)
    (folder / "metadata.yaml").write_text(_metadata_yaml(stamps_ns, topic, msg_type))


@pytest.fixture
def experiments_dir(tmp_path, monkeypatch):
    """Point dataset storage at a temp dir so tests never touch data/."""
    monkeypatch.setattr("src.services.experiments.DATA_DIR", tmp_path)
    return tmp_path


def _project_run(run: dict) -> tuple:
    """Conclusion-bearing run fields, excluding volatile timing fields."""
    return (
        run["status"],
        run["stage"],
        run["anomalyCount"],
        run["worstSeverity"],
        run["model"],
    )


def _project_detections(detections: list[dict]) -> list[tuple]:
    """Raw detection signature used to compare conclusions across runs."""
    return [
        (
            d["kind"],
            d["topic"],
            float(d["tSec"]),
            float(d["endSec"]),
            d["severity"],
            float(d["confidence"]),
        )
        for d in detections
    ]


def _project_anomaly_summaries(anomalies: list[dict]) -> list[tuple]:
    """API anomaly summary signature (shape from ``AnomalySummary``)."""
    return [
        (
            a["kind"],
            tuple(a["topics"]),
            float(a["tSec"]),
            float(a["endSec"]),
            a["severity"],
            float(a["confidence"]),
            a["title"],
        )
        for a in anomalies
    ]


def _project_ai_results(results: list[dict]) -> list[tuple]:
    """AI explanation signature, excluding volatile latency/token fields."""
    return [
        (
            r["anomalyId"],
            r["issue"],
            r["rootCause"],
            r["explanation"],
            tuple(r["suggestedFix"]),
            r["model"],
        )
        for r in results
    ]


def _project_health(health: dict) -> tuple:
    """Health summary signature, excluding no dynamic fields."""
    return (
        health["health_score"],
        health["status"],
        health["summary"]["total_messages"],
        health["summary"]["total_detections"],
        health["summary"]["worst_severity"],
        tuple(
            (group, info["score"], info["detection_count"])
            for group, info in health["summary"]["groups"].items()
        ),
    )


def _run_service_analysis(dataset_id: str) -> list[dict]:
    """Run the full service pipeline repeatedly on the same bag."""
    results = []
    for _ in range(_REPEATS):
        result = run_analysis(dataset_id)
        assert result["run"].anomalyCount == 4  # bag fixture is non-trivial
        results.append(result)
    return results


# ---------------------------------------------------------------------------
# Service layer
# ---------------------------------------------------------------------------


def test_service_analysis_conclusions_consistent_across_runs(experiments_dir):
    folder = experiments_dir / "E1-1"
    _write_dataset(folder, stamps_ns=_BAG_STAMPS_NS)

    results = _run_service_analysis("E1-1")

    first = results[0]
    for result in results[1:]:
        assert _project_run(result["run"].model_dump()) == _project_run(first["run"].model_dump())
        assert _project_detections(result["detections"]) == _project_detections(first["detections"])
        assert _project_ai_results([r.model_dump() for r in result["ai_results"]]) == _project_ai_results(
            [r.model_dump() for r in first["ai_results"]]
        )
        assert _project_health(result["health"]) == _project_health(first["health"])


def test_service_persisted_conclusions_consistent_across_runs(experiments_dir):
    folder = experiments_dir / "E1-1"
    _write_dataset(folder, stamps_ns=_BAG_STAMPS_NS)

    snapshots = []
    for _ in range(_REPEATS):
        run = run_analysis("E1-1")["run"]
        run_id = run.id
        persisted = run_store.get_run(run_id)
        assert persisted["anomalyCount"] == 4
        snapshots.append(
            (
                _project_run(persisted),
                _project_detections(run_store.get_run_anomalies(run_id)),
                _project_ai_results(run_store.get_run_ai_results(run_id)),
            )
        )

    first = snapshots[0]
    for snapshot in snapshots[1:]:
        assert snapshot == first


# ---------------------------------------------------------------------------
# API layer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_api_analysis_conclusions_consistent_across_runs(client, experiments_dir):
    folder = experiments_dir / "E1-1"
    _write_dataset(folder, stamps_ns=_BAG_STAMPS_NS)

    bodies = []
    for _ in range(_REPEATS):
        response = await client.post("/api/v1/analysis", json={"rosbag_id": "E1-1"})
        assert response.status_code == 202
        body = response.json()
        assert body["run"]["anomalyCount"] == 4

        detail = await client.get(f"/api/v1/analysis/{body['run']['id']}")
        assert detail.status_code == 200
        bodies.append(detail.json())

    first = bodies[0]
    for body in bodies[1:]:
        assert _project_run(body["run"]) == _project_run(first["run"])
        assert _project_anomaly_summaries(body["anomalies"]) == _project_anomaly_summaries(first["anomalies"])
        assert _project_ai_results(body["aiResults"]) == _project_ai_results(first["aiResults"])
