"""Validate Gate 2 fixture paths and ground-truth selections without running E2E tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).with_name("fixtures") / "manifest.json"
TEST_PLAN_PATH = REPO_ROOT / "docs" / "evaluation" / "gate2_test_cases.md"
REQUIRED_CASE_IDS = {"TC01", "TC02", "TC03", "TC04", "TC05"}


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def _require_repo_file(relative_path: str) -> Path:
    path = REPO_ROOT / relative_path
    if not path.is_file():
        raise FileNotFoundError(f"missing Gate 2 input: {relative_path}")
    return path


def _validate_ground_truth(case: dict[str, Any]) -> None:
    _require_repo_file(str(case["bag_path"]))
    _require_repo_file(str(case["metadata_path"]))
    ground_truth_path = _require_repo_file(str(case["ground_truth_path"]))
    ground_truth = _load_json(ground_truth_path)
    expected = case["expected_ground_truth"]

    for field in ("bag_name", "label", "fault_count"):
        if ground_truth.get(field) != expected[field]:
            raise ValueError(
                f"{case['id']} ground truth mismatch for {field}: "
                f"{ground_truth.get(field)!r} != {expected[field]!r}"
            )

    if expected["fault_count"] == 0:
        if ground_truth.get("faults"):
            raise ValueError(f"{case['id']} is healthy but contains fault entries")
        return

    faults = ground_truth.get("faults")
    if not isinstance(faults, list) or not faults:
        raise ValueError(f"{case['id']} has no fault entry")
    fault = faults[0]
    anomaly = fault.get("expected_anomaly", {})
    injection = fault.get("injection", {})
    checks = {
        "fault_type": fault.get("type"),
        "topic": anomaly.get("topic"),
        "severity": anomaly.get("severity"),
        "baseline_hz": anomaly.get("baseline_hz"),
        "observed_hz": anomaly.get("observed_hz"),
        "fault_start_rel_sec": injection.get("t_start_rel_sec"),
        "fault_end_rel_sec": injection.get("t_end_rel_sec"),
    }
    for field, actual in checks.items():
        if actual != expected[field]:
            raise ValueError(
                f"{case['id']} ground truth mismatch for {field}: "
                f"{actual!r} != {expected[field]!r}"
            )


def main() -> int:
    manifest = _load_json(MANIFEST_PATH)
    cases = manifest.get("cases")
    if not isinstance(cases, list):
        raise ValueError("manifest.cases must be a list")

    by_id = {str(case.get("id")): case for case in cases}
    if set(by_id) != REQUIRED_CASE_IDS:
        raise ValueError(f"expected cases {sorted(REQUIRED_CASE_IDS)}, got {sorted(by_id)}")
    if manifest.get("execution_status") not in {"NOT EXECUTED", "PARTIAL", "PASS", "FAIL", "BLOCKED"}:
        raise ValueError("manifest.execution_status is not a supported Gate 2 status")

    case_statuses = {str(case.get("actual_status", "NOT EXECUTED")) for case in cases}
    if not case_statuses <= {"PASS", "FAIL", "BLOCKED", "NOT EXECUTED"}:
        raise ValueError(f"unsupported case statuses: {sorted(case_statuses)}")

    for case_id in ("TC01", "TC02", "TC03"):
        _validate_ground_truth(by_id[case_id])

    invalid_fixture = _require_repo_file(str(by_id["TC04"]["fixture_path"]))
    if invalid_fixture.suffix.lower() in {".db3", ".mcap", ".bag", ".zip"}:
        raise ValueError("TC04 fixture must use an unsupported extension")
    if "not a ROS bag" not in invalid_fixture.read_text(encoding="utf-8"):
        raise ValueError("TC04 fixture does not contain its intentional-invalid marker")

    if by_id["TC05"].get("depends_on") != "TC02":
        raise ValueError("TC05 must consume the actual TC02 detection")

    test_plan = TEST_PLAN_PATH.read_text(encoding="utf-8")
    for case_id in sorted(REQUIRED_CASE_IDS):
        if f"## {case_id}" not in test_plan:
            raise ValueError(f"test plan is missing {case_id}")
    for case_id, case in by_id.items():
        status = case.get("actual_status", "NOT EXECUTED")
        section = test_plan.split(f"## {case_id}", 1)[1].split("\n## ", 1)[0]
        if f"Status: {status}" not in section:
            raise ValueError(f"{case_id} plan status does not match manifest: {status}")

    file_backed_cases = sum(
        1 for case in cases if case.get("bag_path") or case.get("fixture_path")
    )
    print("Gate 2 fixture validation: OK")
    print(f"Validated {len(cases)} cases and {file_backed_cases} local file-backed inputs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
