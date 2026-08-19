"""Execute Gate 2 API cases against a running ROS2 Doctor backend.

The script stores unmodified HTTP responses plus a machine-readable verdict for
TC01-TC04.  It never marks a case as passed unless the corresponding requests
completed and the assertions below matched the Task 1 oracle.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
import time
from typing import Any

import httpx
from rosbags.highlevel import AnyReader


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVIDENCE_ROOT = REPO_ROOT / "eval" / "gate2" / "evidence"
INPUTS = {
    "TC01": REPO_ROOT / "data/dataset/bags/healthy/healthy_01/healthy_01_0.mcap",
    "TC02": REPO_ROOT / "data/dataset/bags/faulty/F1_02/F1_02_0.mcap",
    "TC03": REPO_ROOT / "data/dataset/bags/faulty/F1_01/F1_01_0.mcap",
    "TC04": REPO_ROOT / "eval/gate2/fixtures/not_a_rosbag.txt",
}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _response_record(response: httpx.Response) -> dict[str, Any]:
    try:
        body: Any = response.json()
    except json.JSONDecodeError:
        body = response.text
    return {
        "captured_at": _now(),
        "status_code": response.status_code,
        "headers": {
            key: value
            for key, value in response.headers.items()
            if key.lower() in {"content-type", "content-length", "date", "server"}
        },
        "body": body,
    }


def _request(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    timeout: float = 600.0,
    **kwargs: Any,
) -> tuple[httpx.Response, float]:
    started = time.perf_counter()
    response = client.request(method, url, timeout=timeout, **kwargs)
    return response, round(time.perf_counter() - started, 3)


def _raw_detections(health_response: dict[str, Any]) -> list[dict[str, Any]]:
    health = health_response.get("health", {})
    grouped = health.get("detections_by_group", {})
    detections: list[dict[str, Any]] = []
    if isinstance(grouped, dict):
        for values in grouped.values():
            if isinstance(values, list):
                detections.extend(item for item in values if isinstance(item, dict))
    return detections


def _measure_topic_silence(path: Path, topic: str) -> dict[str, Any]:
    topic_last_ns: int | None = None
    bag_start_ns: int | None = None
    bag_end_ns: int | None = None
    topic_count = 0
    topic_timestamps_ns: list[int] = []
    with AnyReader([path]) as reader:
        for connection, timestamp_ns, _ in reader.messages():
            bag_start_ns = timestamp_ns if bag_start_ns is None else min(bag_start_ns, timestamp_ns)
            bag_end_ns = timestamp_ns if bag_end_ns is None else max(bag_end_ns, timestamp_ns)
            if connection.topic == topic:
                topic_count += 1
                topic_last_ns = timestamp_ns
                topic_timestamps_ns.append(timestamp_ns)
    if bag_start_ns is None or bag_end_ns is None or topic_last_ns is None:
        raise ValueError(f"could not measure {topic} in {path}")
    gaps = [
        (end_ns - start_ns, start_ns, end_ns)
        for start_ns, end_ns in pairwise(topic_timestamps_ns)
    ]
    max_gap_ns, gap_start_ns, gap_end_ns = max(gaps)
    return {
        "topic": topic,
        "topic_message_count": topic_count,
        "bag_start_sec": bag_start_ns / 1e9,
        "bag_end_sec": bag_end_ns / 1e9,
        "last_topic_timestamp_sec": topic_last_ns / 1e9,
        "silent_tail_sec": (bag_end_ns - topic_last_ns) / 1e9,
        "max_gap_sec": max_gap_ns / 1e9,
        "max_gap_start_sec": gap_start_ns / 1e9,
        "max_gap_end_sec": gap_end_ns / 1e9,
    }


def _execute_analysis_case(
    client: httpx.Client,
    base_url: str,
    case_id: str,
    phase: str,
    evidence_root: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    source = INPUTS[case_id]
    case_dir = evidence_root / case_id / phase
    case_dir.mkdir(parents=True, exist_ok=True)
    _write_json(
        case_dir / "input.json",
        {
            "case_id": case_id,
            "source": str(source.relative_to(REPO_ROOT)).replace("\\", "/"),
            "size_bytes": source.stat().st_size,
            "sha256": _sha256(source),
        },
    )

    dataset_id: str | None = None
    started_at = _now()
    started = time.perf_counter()
    timings: dict[str, float] = {}
    try:
        with source.open("rb") as handle:
            upload, timings["upload_sec"] = _request(
                client,
                "POST",
                f"{base_url}/datasets/upload",
                files={"file": (source.name, handle, "application/octet-stream")},
            )
        upload_record = _response_record(upload)
        _write_json(case_dir / "upload_response.json", upload_record)
        if upload.status_code != 201 or not isinstance(upload_record["body"], dict):
            result = {
                "case_id": case_id,
                "status": "FAIL",
                "reason": "valid MCAP upload did not return HTTP 201",
            }
            return result, {}
        dataset_id = str(upload_record["body"]["id"])

        create, timings["analysis_sec"] = _request(
            client,
            "POST",
            f"{base_url}/analysis",
            json={"rosbag_id": dataset_id},
        )
        create_record = _response_record(create)
        _write_json(case_dir / "analysis_create_response.json", create_record)
        if create.status_code != 202 or not isinstance(create_record["body"], dict):
            result = {
                "case_id": case_id,
                "status": "FAIL",
                "reason": "analysis creation did not return HTTP 202",
            }
            return result, {}
        run_id = str(create_record["body"]["run"]["id"])

        detail, timings["detail_sec"] = _request(client, "GET", f"{base_url}/analysis/{run_id}")
        detail_record = _response_record(detail)
        _write_json(case_dir / "analysis_detail_response.json", detail_record)

        health, timings["health_sec"] = _request(
            client, "GET", f"{base_url}/analysis/{run_id}/health"
        )
        health_record = _response_record(health)
        _write_json(case_dir / "health_response.json", health_record)

        detail_body = detail_record["body"] if isinstance(detail_record["body"], dict) else {}
        health_body = health_record["body"] if isinstance(health_record["body"], dict) else {}
        anomalies = detail_body.get("anomalies", [])
        raw = _raw_detections(health_body)
        run = detail_body.get("run", {})

        if case_id == "TC01":
            severe = [item for item in anomalies if item.get("severity") in {"high", "critical"}]
            report_health = health_body.get("health", {})
            checks = {
                "run_succeeded": run.get("status") == "succeeded",
                "message_count": detail_body.get("rosbag", {}).get("messageCount") == 64953,
                "topics_parsed": len(detail_body.get("rosbag", {}).get("topics", [])) == 8,
                "no_high_or_critical": not severe,
                "health_green": report_health.get("status") == "green",
                "no_auto_llm": report_health.get("trigger_llm_deep_dive") is False,
            }
            result = {
                "case_id": case_id,
                "status": "PASS" if all(checks.values()) else "FAIL",
                "checks": checks,
                "anomaly_count": len(anomalies),
                "severe_anomalies": severe,
                "health_score": report_health.get("health_score"),
            }
        elif case_id == "TC02":
            relevant = [
                item
                for item in raw
                if item.get("topic") == "/scan"
                and item.get("kind") in {"frequency_gap", "hz_drop", "hz_drop_critical"}
            ]
            strongest = next(
                (item for item in relevant if item.get("kind") == "hz_drop_critical"),
                relevant[0] if relevant else None,
            )
            checks = {
                "run_succeeded": run.get("status") == "succeeded",
                "frequency_anomaly_detected": bool(relevant),
                "correct_topic": bool(strongest and strongest.get("topic") == "/scan"),
            }
            result = {
                "case_id": case_id,
                "status": "PASS" if all(checks.values()) else "FAIL",
                "checks": checks,
                "expected_frequency_hz": 10.0,
                "ground_truth_frequency_hz": 2.5,
                "actual_detector_output": strongest,
                "all_scan_frequency_detections": relevant,
            }
        else:
            measurement = _measure_topic_silence(source, "/scan")
            _write_json(case_dir / "topic_silence_measurement.json", measurement)
            relevant = [
                item
                for item in raw
                if item.get("topic") == "/scan" and item.get("kind") == "silent_node"
            ]
            strongest = next(
                (item for item in relevant if item.get("severity") == "critical"),
                relevant[0] if relevant else None,
            )
            evidence = strongest.get("evidence", {}) if strongest else {}
            detected_duration = evidence.get("silent_duration_sec")
            checks = {
                "run_succeeded": run.get("status") == "succeeded",
                "silent_node_detected": bool(strongest),
                "correct_topic": bool(strongest and strongest.get("topic") == "/scan"),
                "critical_severity": bool(strongest and strongest.get("severity") == "critical"),
                "duration_matches": isinstance(detected_duration, (int, float))
                and abs(float(detected_duration) - measurement["max_gap_sec"]) <= 5.0,
            }
            result = {
                "case_id": case_id,
                "status": "PASS" if all(checks.values()) else "FAIL",
                "checks": checks,
                "measured_topic_silence": measurement,
                "threshold_sec": evidence.get("threshold_sec"),
                "actual_detector_output": strongest,
            }

        result.update(
            {
                "started_at": started_at,
                "finished_at": _now(),
                "execution_time_sec": round(time.perf_counter() - started, 3),
                "timings": timings,
                "dataset_id": dataset_id,
                "run_id": run_id,
            }
        )
        _write_json(case_dir / "result.json", result)
        return result, health_body
    finally:
        if dataset_id:
            cleanup, cleanup_sec = _request(
                client, "DELETE", f"{base_url}/datasets/{dataset_id}", timeout=120.0
            )
            _write_json(
                case_dir / "cleanup_response.json",
                {**_response_record(cleanup), "execution_time_sec": cleanup_sec},
            )


def _execute_invalid_case(
    client: httpx.Client,
    base_url: str,
    phase: str,
    evidence_root: Path,
) -> dict[str, Any]:
    case_dir = evidence_root / "TC04" / phase
    case_dir.mkdir(parents=True, exist_ok=True)
    source = INPUTS["TC04"]
    before, _ = _request(client, "GET", f"{base_url}/datasets")
    before_record = _response_record(before)
    _write_json(case_dir / "datasets_before.json", before_record)

    started_at = _now()
    with source.open("rb") as handle:
        response, execution_time = _request(
            client,
            "POST",
            f"{base_url}/datasets/upload",
            files={"file": (source.name, handle, "text/plain")},
        )
    response_record = _response_record(response)
    _write_json(case_dir / "upload_response.json", response_record)

    after, _ = _request(client, "GET", f"{base_url}/datasets")
    after_record = _response_record(after)
    _write_json(case_dir / "datasets_after.json", after_record)
    health, _ = _request(client, "GET", base_url.removesuffix("/api/v1") + "/health")
    health_record = _response_record(health)
    _write_json(case_dir / "backend_health_after.json", health_record)

    before_body = before_record["body"] if isinstance(before_record["body"], dict) else {}
    after_body = after_record["body"] if isinstance(after_record["body"], dict) else {}
    detail = response_record["body"].get("detail", "") if isinstance(response_record["body"], dict) else ""
    checks = {
        "http_400": response.status_code == 400,
        "clear_error": "unsupported file type" in detail,
        "registry_unchanged": before_body.get("total") == after_body.get("total"),
        "backend_healthy": health.status_code == 200,
    }
    result = {
        "case_id": "TC04",
        "status": "PASS" if all(checks.values()) else "FAIL",
        "checks": checks,
        "actual_status_code": response.status_code,
        "actual_error": response_record["body"],
        "started_at": started_at,
        "finished_at": _now(),
        "execution_time_sec": execution_time,
    }
    _write_json(case_dir / "result.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:8000/api/v1")
    parser.add_argument("--phase", default="current")
    parser.add_argument("--evidence-root", type=Path, default=DEFAULT_EVIDENCE_ROOT)
    args = parser.parse_args()

    missing = [str(path) for path in INPUTS.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"missing Gate 2 inputs: {missing}")

    base_url = args.base_url.rstrip("/")
    summary: dict[str, Any] = {
        "phase": args.phase,
        "base_url": base_url,
        "started_at": _now(),
        "results": [],
    }
    with httpx.Client() as client:
        tc02_health: dict[str, Any] = {}
        for case_id in ("TC01", "TC02", "TC03"):
            result, health = _execute_analysis_case(
                client, base_url, case_id, args.phase, args.evidence_root
            )
            summary["results"].append(result)
            if case_id == "TC02":
                tc02_health = health
        summary["results"].append(
            _execute_invalid_case(client, base_url, args.phase, args.evidence_root)
        )
        _write_json(
            args.evidence_root / "TC05" / args.phase / "tc02_health_input.json",
            tc02_health,
        )

    summary["finished_at"] = _now()
    _write_json(args.evidence_root / f"api_execution_{args.phase}.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if all(item["status"] == "PASS" for item in summary["results"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
