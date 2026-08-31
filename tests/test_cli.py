"""CLI integration tests: drive src.cli.main() directly and assert stdout/exit codes."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from src.cli import main
from src.services import run_store
from src.services.hilt_store import list_hilt_reviews

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "diagnostics"


@pytest.fixture
def experiments_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr("src.services.experiments.DATA_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def hilt_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HILT_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def thresholds_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "thresholds.json"
    monkeypatch.setenv("DIAGNOSTICS_THRESHOLDS_FILE", str(path))
    return path


def _make_bag_folder(base: Path, folder_name: str = "E1-1") -> Path:
    folder = base / folder_name
    folder.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(folder / "bag.db3")
    conn.execute("CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT, type TEXT)")
    conn.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER, timestamp INTEGER, data BLOB)")
    conn.execute("INSERT INTO topics VALUES (1, '/scan', 'sensor_msgs/msg/LaserScan')")
    conn.executemany(
        "INSERT INTO messages(topic_id, timestamp) VALUES (1, ?)",
        [(t,) for t in (1_000_000_000, 1_200_000_000, 5_000_000_000, 5_200_000_000)],
    )
    conn.commit()
    conn.close()
    return folder


def _run(capsys: pytest.CaptureFixture, *args: str) -> tuple[int, str, str]:
    code = main(list(args))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _seed_run(run_id: str = "run_cli_1") -> None:
    run_store.save_run(
        {
            "id": run_id,
            "rosbagId": "E1-1",
            "rosbagName": "bag.db3",
            "robotType": "amr-delivery",
            "status": "succeeded",
            "progress": 100,
            "stage": "done",
            "startedAt": "2026-08-04T00:00:00+00:00",
            "finishedAt": "2026-08-04T00:00:01+00:00",
            "anomalyCount": 1,
            "worstSeverity": "medium",
            "model": "openai/gpt-4.1",
            "totalLatencyMs": 12,
            "promptTokens": 0,
            "completionTokens": 0,
            "costUsd": 0.0,
        }
    )
    run_store.save_run_anomalies(
        run_id,
        [
            {
                "kind": "frequency_gap",
                "topic": "/scan",
                "severity": "medium",
                "confidence": 0.81,
                "tSec": 1.0,
                "endSec": 2.0,
                "evidence": {"interval_sec": 2.0, "threshold_sec": 0.5},
            }
        ],
    )
    run_store.save_run_ai_results(
        run_id,
        [
            {
                "anomalyId": "anomaly_001",
                "model": "canned-fallback",
                "confidence": 0.81,
                "reviewStatus": "pending",
                "rootCause": "Producer thread starvation paused publishing.",
                "issue": "Producer thread starvation paused publishing.",
                "explanation": "Frequent publish gap detected on /scan.",
            }
        ],
    )
    run_store.save_review_items(
        [
            {
                "id": "review_cli_1",
                "runId": run_id,
                "anomalyId": "anomaly_001",
                "reviewStatus": "pending",
                "rootCause": "Producer thread starvation paused publishing.",
                "explanation": "Frequent publish gap detected on /scan.",
            }
        ]
    )


def _seed_debug_run(run_id: str = "run_cli_1") -> None:
    _seed_run(run_id)
    run_store.save_run_anomalies(
        run_id,
        [
            {
                "id": "001",
                "kind": "frequency_gap",
                "topic": "/scan",
                "severity": "medium",
                "confidence": 0.4,
                "tSec": 1.0,
                "endSec": 2.0,
                "evidence": {"interval_sec": 2.0, "threshold_sec": 0.5},
            }
        ],
    )


def _seed_clean_run(run_id: str = "run_cli_clean") -> None:
    run_store.save_run(
        {
            "id": run_id,
            "rosbagId": "E1-1",
            "rosbagName": "bag.db3",
            "robotType": "amr-delivery",
            "status": "succeeded",
            "progress": 100,
            "stage": "done",
            "startedAt": "2026-08-04T00:00:00+00:00",
            "finishedAt": "2026-08-04T00:00:01+00:00",
            "anomalyCount": 0,
            "worstSeverity": None,
            "model": "openai/gpt-4.1",
            "totalLatencyMs": 12,
            "promptTokens": 0,
            "completionTokens": 0,
            "costUsd": 0.0,
        }
    )


def test_datasets_list_json(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _make_bag_folder(experiments_dir)
    code, out, _ = _run(capsys, "datasets", "list")
    assert code == 0
    items = json.loads(out)
    assert [item["id"] for item in items] == ["E1-1"]
    assert items[0]["messageCount"] == 4


def test_datasets_list_table(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _make_bag_folder(experiments_dir)
    code, out, _ = _run(capsys, "-o", "table", "datasets", "list")
    assert code == 0
    assert "E1-1" in out
    assert "messages" in out


def test_datasets_list_empty_table(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    code, out, _ = _run(capsys, "-o", "table", "datasets", "list")
    assert code == 0
    assert "(empty)" in out


def test_datasets_upload_and_delete(experiments_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    source = _make_bag_folder(tmp_path, "upload-src") / "bag.db3"
    code, out, _ = _run(capsys, "datasets", "upload", str(source))
    assert code == 0
    assert json.loads(out)["id"] == "bag"

    code, out, _ = _run(capsys, "datasets", "delete", "bag")
    assert code == 0
    assert json.loads(out)["ok"] is True
    assert not (experiments_dir / "bag").exists()

    code, _, err = _run(capsys, "datasets", "delete", "bag")
    assert code == 1
    assert "not found" in err


def test_datasets_upload_missing_file(capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "datasets", "upload", "does-not-exist.db3")
    assert code == 1
    assert "upload failed" in err


def test_diagnose_jsonl(capsys: pytest.CaptureFixture) -> None:
    code, out, _ = _run(capsys, "diagnose", str(FIXTURES_DIR / "sample.jsonl"))
    assert code == 0
    body = json.loads(out)
    assert body["summary"]["total_messages"] == 2


def test_diagnose_db3(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    folder = _make_bag_folder(experiments_dir)
    code, out, _ = _run(capsys, "diagnose", str(folder / "bag.db3"))
    assert code == 0
    body = json.loads(out)
    assert "detections" in body
    assert body["summary"]["total_messages"] == 4


def test_diagnose_unknown_threshold(capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "diagnose", str(FIXTURES_DIR / "sample.jsonl"), "--threshold", "bogus=1.0")
    assert code == 2
    assert "unknown threshold" in err


def test_analyze_persists_run(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _make_bag_folder(experiments_dir)
    code, out, _ = _run(capsys, "analyze", "E1-1")
    assert code == 0
    body = json.loads(out)
    assert body["run"]["status"] == "succeeded"
    assert body["run"]["anomalyCount"] >= 1
    assert any(item["kind"] == "silent_node" for item in body["anomalies"])
    assert run_store.get_run("run_E1-1") is not None
    assert run_store.get_review_item("review_run_E1-1_001") is not None


def test_analyze_table(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _make_bag_folder(experiments_dir)
    code, out, _ = _run(capsys, "-o", "table", "analyze", "E1-1")
    assert code == 0
    assert "run run_E1-1" in out
    assert "silent_node" in out


def test_analyze_missing_dataset(capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "analyze", "missing")
    assert code == 1
    assert "not found" in err


def test_thresholds_show_and_set(thresholds_file: Path, capsys: pytest.CaptureFixture) -> None:
    code, out, _ = _run(capsys, "thresholds", "show")
    assert code == 0
    assert json.loads(out)["thresholds"]["frequency_gap_min_threshold_sec"] == 0.08

    code, out, _ = _run(capsys, "thresholds", "set", "silent_node_min_span_sec=0.5")
    assert code == 0
    assert json.loads(out)["thresholds"]["silent_node_min_span_sec"] == 0.5

    code, out, _ = _run(capsys, "thresholds", "show")
    assert json.loads(out)["thresholds"]["silent_node_min_span_sec"] == 0.5


def test_thresholds_set_invalid_key(thresholds_file: Path, capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "thresholds", "set", "nope=1.0")
    assert code == 2
    assert "unknown threshold" in err


def test_runs_list_and_show(capsys: pytest.CaptureFixture) -> None:
    _seed_run()
    code, out, _ = _run(capsys, "runs", "list")
    assert code == 0
    assert [run["id"] for run in json.loads(out)] == ["run_cli_1"]

    code, out, _ = _run(capsys, "runs", "show", "run_cli_1")
    assert code == 0
    body = json.loads(out)
    assert body["run"]["id"] == "run_cli_1"
    assert body["anomalies"][0]["kind"] == "frequency_gap"
    assert body["ai_results"][0]["rootCause"] == "Producer thread starvation paused publishing."


def test_runs_show_missing(capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "runs", "show", "nope")
    assert code == 1
    assert "not found" in err


def test_review_list_and_decide(capsys: pytest.CaptureFixture) -> None:
    _seed_run()
    code, out, _ = _run(capsys, "review", "list")
    assert code == 0
    assert [item["id"] for item in json.loads(out)] == ["review_cli_1"]

    code, out, _ = _run(capsys, "review", "decide", "review_cli_1", "approved", "--reviewer", "alice", "--notes", "ok")
    assert code == 0
    assert json.loads(out)["verdict"] == "approved"
    assert run_store.get_review_item("review_cli_1")["reviewStatus"] == "approved"


def test_review_list_empty_table(capsys: pytest.CaptureFixture) -> None:
    code, out, _ = _run(capsys, "-o", "table", "review", "list")
    assert code == 0
    assert "(empty)" in out


def test_review_decide_missing(capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "review", "decide", "nope", "approved")
    assert code == 1
    assert "not found" in err


def test_export_windows_to_file(experiments_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    _make_bag_folder(experiments_dir)
    out_path = tmp_path / "windows.jsonl"
    code, out, _ = _run(capsys, "export", "windows", "E1-1", "--window", "10", "--out", str(out_path))
    assert code == 0
    assert json.loads(out)["windows"] == 1
    body = json.loads(out_path.read_text(encoding="utf-8").strip().splitlines()[0])
    assert body["topic"] == "/scan"
    assert body["count"] == 4


def test_export_windows_stdout(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _make_bag_folder(experiments_dir)
    code, out, _ = _run(capsys, "export", "windows", "E1-1", "--window", "10")
    assert code == 0
    assert json.loads(out.strip().splitlines()[0])["topic"] == "/scan"


def test_export_missing_dataset(capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "export", "windows", "ghost")
    assert code == 1
    assert "not found" in err


def test_hilt_review_noninteractive(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_run()
    code, out, _ = _run(
        capsys,
        "hilt",
        "review",
        "run_cli_1",
        "--label",
        "partial",
        "--comment",
        "IMU đúng là bị drop nhưng nguyên nhân không phải driver",
    )
    assert code == 0
    body = json.loads(out)
    assert body["records"][0]["label"] == "partial"
    assert body["records"][0]["comment"] == "IMU đúng là bị drop nhưng nguyên nhân không phải driver"
    assert list_hilt_reviews("run_cli_1")[0]["prediction"] == "Producer thread starvation paused publishing."


def test_hilt_review_interactive(
    hilt_dir: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_run()
    answers = iter(["2", "IMU bị drop thật, driver ổn"])
    monkeypatch.setattr("builtins.input", lambda *args: next(answers))
    code, out, _ = _run(capsys, "hilt", "review", "run_cli_1")
    assert code == 0
    assert "wrong" in out
    assert "IMU bị drop thật, driver ổn" in out
    assert list_hilt_reviews("run_cli_1")[0]["label"] == "wrong"


def test_hilt_review_interactive_default_correct(
    hilt_dir: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_run()
    answers = iter(["", ""])
    monkeypatch.setattr("builtins.input", lambda *args: next(answers))
    code, _, _ = _run(capsys, "hilt", "review", "run_cli_1")
    assert code == 0
    assert list_hilt_reviews("run_cli_1")[0]["label"] == "correct"
    assert list_hilt_reviews("run_cli_1")[0]["comment"] == ""


def test_hilt_review_index(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_run()
    code, out, _ = _run(capsys, "hilt", "review", "run_cli_1", "--index", "1", "--label", "correct")
    assert code == 0
    assert json.loads(out)["records"][0]["label"] == "correct"

    code, _, err = _run(capsys, "hilt", "review", "run_cli_1", "--index", "99", "--label", "correct")
    assert code == 2
    assert "out of range" in err


def test_hilt_review_missing_run(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "hilt", "review", "ghost")
    assert code == 1
    assert "not found" in err


def test_hilt_list(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_run()
    _run(capsys, "hilt", "review", "run_cli_1", "--label", "correct")
    code, out, _ = _run(capsys, "hilt", "list", "run_cli_1")
    assert code == 0
    body = json.loads(out)
    assert len(body["reviews"]) == 1
    assert body["reviews"][0]["label"] == "correct"


def test_chat_unconfigured(capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("src.cli.is_llm_configured", lambda: False)
    code, _, err = _run(capsys, "chat", "hello")
    assert code == 1
    assert "not configured" in err


def test_chat_configured(capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("src.cli.is_llm_configured", lambda: True)
    monkeypatch.setattr(
        "src.cli.chat_completion",
        lambda messages, tools=None: {"message": {"content": "chào bạn"}, "prompt_tokens": 0, "completion_tokens": 0, "latency_ms": 0},
    )
    code, out, _ = _run(capsys, "chat", "hello")
    assert code == 0
    assert json.loads(out)["response"] == "chào bạn"


def test_explain(tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    summary = {
        "summary": {"total_detections": 1, "severity": "medium"},
        "detections": [{"kind": "frequency_gap", "topic": "/scan"}],
    }
    summary_file = tmp_path / "summary.json"
    summary_file.write_text(json.dumps(summary), encoding="utf-8")
    monkeypatch.setattr(
        "src.cli.explain_diagnostics",
        lambda summary: {"root_cause": "rc", "recommended_actions": ["a"], "explanation": "e"},
    )
    code, out, _ = _run(capsys, "explain", str(summary_file))
    assert code == 0
    assert json.loads(out)["root_cause"] == "rc"


def test_analyze_model_label(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _make_bag_folder(experiments_dir)
    code, out, _ = _run(capsys, "analyze", "E1-1", "--model", "custom-model")
    assert code == 0
    assert json.loads(out)["run"]["model"] == "custom-model"


def test_diagnose_threshold_override(capsys: pytest.CaptureFixture) -> None:
    code, out, _ = _run(
        capsys,
        "diagnose",
        str(FIXTURES_DIR / "sample.jsonl"),
        "--threshold",
        "frequency_gap_min_threshold_sec=0.5",
    )
    assert code == 0
    assert json.loads(out)["summary"]["total_messages"] == 2


def test_diagnose_table(experiments_dir: Path, capsys: pytest.CaptureFixture) -> None:
    folder = _make_bag_folder(experiments_dir)
    code, out, _ = _run(capsys, "-o", "table", "diagnose", str(folder / "bag.db3"))
    assert code == 0
    assert "messages=" in out
    assert "detections=" in out


def test_runs_show_table(capsys: pytest.CaptureFixture) -> None:
    _seed_run()
    code, out, _ = _run(capsys, "-o", "table", "runs", "show", "run_cli_1")
    assert code == 0
    assert "run run_cli_1" in out
    assert "frequency_gap" in out


def test_review_list_filters_pending(capsys: pytest.CaptureFixture) -> None:
    _seed_run()
    run_store.save_review_items(
        [
            {
                "id": "review_cli_approved",
                "runId": "run_cli_1",
                "anomalyId": "anomaly_001",
                "reviewStatus": "approved",
                "rootCause": "Producer thread starvation paused publishing.",
                "explanation": "Frequent publish gap detected on /scan.",
            }
        ]
    )
    code, out, _ = _run(capsys, "review", "list")
    assert code == 0
    ids = [item["id"] for item in json.loads(out)]
    assert ids == ["review_cli_1"]
    assert "review_cli_approved" not in ids


def test_explain_missing_file(capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "explain", "does-not-exist.json")
    assert code == 1
    assert "error" in err


def test_explain_invalid_json(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{not valid json", encoding="utf-8")
    code, _, err = _run(capsys, "explain", str(bad))
    assert code == 1
    assert "error" in err


def test_chat_llm_error(capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("src.cli.is_llm_configured", lambda: True)

    def boom(*args, **kwargs):
        raise RuntimeError("upstream unavailable")

    monkeypatch.setattr("src.cli.chat_completion", boom)
    code, _, err = _run(capsys, "chat", "hello")
    assert code == 1
    assert "upstream unavailable" in err


def test_hilt_iterate_test_pass(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_debug_run()
    code, out, _ = _run(capsys, "hilt", "iterate", "run_cli_1", "--test-pass", "--test-comment", "ok")
    assert code == 0
    iterations = run_store.list_hilt_iterations("run_cli_1", "anomaly_001")
    assert len(iterations) == 1
    assert iterations[0]["test_pass"] is True
    assert iterations[0]["test_comment"] == "ok"
    assert "Root Cause" in out


def test_hilt_iterate_missing_run(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "hilt", "iterate", "ghost")
    assert code == 1
    assert "not found" in err


def test_hilt_iterate_no_anomalies(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_clean_run()
    code, _, err = _run(capsys, "hilt", "iterate", "run_cli_clean")
    assert code == 1
    assert "no anomalies" in err


def test_hilt_iterate_anomaly_not_found(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_debug_run()
    code, _, err = _run(capsys, "hilt", "iterate", "run_cli_1", "--anomaly-id", "anomaly_999")
    assert code == 1
    assert "anomaly not found" in err


def test_hilt_triggers_no_iterations(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_debug_run()
    code, out, _ = _run(capsys, "hilt", "triggers", "run_cli_1")
    assert code == 0
    body = json.loads(out)
    assert body["triggers"] == []
    assert "No iterations yet" in body["message"]


def test_hilt_triggers_missing_run(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "hilt", "triggers", "ghost")
    assert code == 1
    assert "not found" in err


def test_hilt_triggers_no_anomalies(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_clean_run()
    code, _, err = _run(capsys, "hilt", "triggers", "run_cli_clean")
    assert code == 1
    assert "no anomalies" in err


def test_hilt_summary(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_debug_run()
    _run(capsys, "hilt", "iterate", "run_cli_1", "--test-pass", "--test-comment", "saw nothing")
    code, out, _ = _run(capsys, "hilt", "summary", "run_cli_1")
    assert code == 0
    body = json.loads(out)
    assert body["run_id"] == "run_cli_1"
    assert body["anomaly_id"] == "anomaly_001"
    assert len(body["iterations"]) == 1


def test_hilt_summary_missing_run(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    code, _, err = _run(capsys, "hilt", "summary", "ghost")
    assert code == 1
    assert "not found" in err


def test_hilt_review_no_ai_results(hilt_dir: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_clean_run()
    code, _, err = _run(capsys, "hilt", "review", "run_cli_clean")
    assert code == 1
    assert "no AI results" in err


def test_export_windows_out_error(experiments_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    _make_bag_folder(experiments_dir)
    missing_dir = tmp_path / "no" / "such" / "dir.jsonl"
    code, _, err = _run(capsys, "export", "windows", "E1-1", "--out", str(missing_dir))
    assert code == 1
    assert "error" in err


def test_hilt_unknown_subcommand_exits_2() -> None:
    with pytest.raises(SystemExit) as exc:
        main(["hilt", "bogus", "run_cli_1"])
    assert exc.value.code == 2


def test_no_command_exits_2() -> None:
    with pytest.raises(SystemExit) as exc:
        main([])
    assert exc.value.code == 2


def test_invalid_choices_exit_2(capsys: pytest.CaptureFixture) -> None:
    with pytest.raises(SystemExit):
        main(["review", "decide", "x", "maybe"])
    with pytest.raises(SystemExit):
        main(["hilt", "review", "run_cli_1", "--label", "maybe"])
