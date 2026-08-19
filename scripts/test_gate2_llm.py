"""Call the live Gate 2 diagnosis endpoint with TC02's actual detector output.

The script captures the exact request and HTTP response. It intentionally does
not invent a diagnosis or silently replace a failed upstream call with evidence
that looks live.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
from pathlib import Path
import time
from typing import Any

import httpx


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVIDENCE_ROOT = REPO_ROOT / "eval" / "gate2" / "evidence"


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:8000/api/v1")
    parser.add_argument("--phase", default="final")
    parser.add_argument("--evidence-root", type=Path, default=DEFAULT_EVIDENCE_ROOT)
    args = parser.parse_args()

    case_dir = args.evidence_root / "TC05" / args.phase
    source = case_dir / "tc02_health_input.json"
    detector_output = json.loads(source.read_text(encoding="utf-8"))
    request_body = {"summary": detector_output}
    _write_json(case_dir / "llm_request.json", request_body)

    started_at = datetime.now(UTC).isoformat()
    started = time.perf_counter()
    try:
        response = httpx.post(
            f"{args.base_url.rstrip('/')}/analysis/explain",
            json=request_body,
            timeout=90.0,
        )
        execution_time = round(time.perf_counter() - started, 3)
        try:
            body: Any = response.json()
        except json.JSONDecodeError:
            body = response.text
        record = {
            "captured_at": datetime.now(UTC).isoformat(),
            "status_code": response.status_code,
            "execution_time_sec": execution_time,
            "body": body,
        }
        _write_json(case_dir / "llm_response.json", record)
        summary = {
            "case_id": "TC05",
            "started_at": started_at,
            "finished_at": datetime.now(UTC).isoformat(),
            "execution_time_sec": execution_time,
            "http_status": response.status_code,
            "pipeline_completed": response.status_code == 200,
            "response_captured": isinstance(body, dict) and bool(body.get("root_cause")),
        }
        _write_json(case_dir / "execution.json", summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0 if summary["pipeline_completed"] and summary["response_captured"] else 1
    except httpx.HTTPError as exc:
        execution_time = round(time.perf_counter() - started, 3)
        failure = {
            "case_id": "TC05",
            "started_at": started_at,
            "finished_at": datetime.now(UTC).isoformat(),
            "execution_time_sec": execution_time,
            "pipeline_completed": False,
            "error_type": type(exc).__name__,
            "error": str(exc),
        }
        _write_json(case_dir / "execution.json", failure)
        print(json.dumps(failure, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
