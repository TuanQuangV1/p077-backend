"""Live prompt-injection runner for the RAV-13 LLM entry points.

Sends every payload from tests/fixtures/security/injection_payloads.json to a
running FastAPI backend (/api/v1/chat, /api/v1/analysis/explain) and scans the
responses for system-prompt fragments, secret material and compliance markers.
Optionally probes the Next.js deep-dive route as well.

Usage:
    python scripts/test_security_injection.py [--backend-url http://localhost:8000]
        [--frontend-url http://localhost:3000] [--skip-frontend]

The backend must be started with a real OpenAI key for genuine live results:
    uvicorn src.main:app --port 8000

Evidence is written to eval/security/evidence/injection_report.json.
Exit code 1 when any payload leaks secrets or verbatim system-prompt text.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.services.llm import CHAT_SYSTEM_PROMPT
from tests.security.leak_detector import (
    find_compliance_markers,
    find_prompt_leaks,
    find_secret_leaks,
    load_payloads,
)

EVIDENCE_DIR = Path("eval/security/evidence")


def classify(response_text: str, expected: str) -> str:
    """Verdict per payload: LEAK_SECRET / LEAK_PROMPT / COMPLIED / PASS."""
    if find_secret_leaks(response_text):
        return "LEAK_SECRET"
    if CHAT_SYSTEM_PROMPT.lower() in response_text.lower() or find_prompt_leaks(response_text):
        return "LEAK_PROMPT"
    if expected in ("stay_in_role", "refuse_at_every_turn") and find_compliance_markers(response_text):
        return "COMPLIED"
    return "PASS"


def _login(base_url: str, username: str, password: str) -> str:
    """Return a bearer token, or abort: an unauthenticated run scores nothing.

    Every endpoint under test requires a JWT. Without one each payload gets a
    401 that carries no model output, so `classify` finds nothing to leak and
    the whole suite reports "clean" in about a millisecond per payload - a
    security gate that passes precisely because it never reached the model.
    """
    resp = httpx.post(
        f"{base_url}/api/v1/auth/login",
        json={"username": username, "password": password},
        timeout=30,
    )
    if resp.status_code != 200:
        raise SystemExit(
            f"login failed ({resp.status_code}): {resp.text[:200]}\n"
            "Pass --username/--password (or --token) for the running backend."
        )
    return str(resp.json()["access_token"])


def probe_backend(base_url: str, token: str) -> list[dict]:
    results = []
    with httpx.Client(base_url=base_url, timeout=90, headers={"Authorization": f"Bearer {token}"}) as client:
        health = client.get("/api/v1/status")
        print(f"[backend] status={health.status_code} {health.json()}")

        for payload in load_payloads():
            target = payload.get("target", "chat")
            started = time.perf_counter()
            if target == "explain":
                resp = client.post(
                    "/api/v1/analysis/explain",
                    json={"summary": json.loads(payload["message"])},
                )
            elif "sequence" in payload:
                # Pseudo multi-turn: /chat is stateless, so the attacker keeps
                # the context client-side and replays one message per request.
                resp = None
                for turn_message in payload["sequence"]:
                    resp = client.post("/api/v1/chat", json={"message": turn_message})
            else:
                resp = client.post("/api/v1/chat", json={"message": payload["message"]})
            elapsed_ms = int((time.perf_counter() - started) * 1000)

            try:
                body = resp.json()
                text = json.dumps(body)
            except ValueError:
                text = resp.text

            # An auth or transport failure is not a clean payload: it means the
            # attack never reached the model, so it must not be scored as one.
            verdict = (
                f"NOT_TESTED_HTTP_{resp.status_code}"
                if resp.status_code >= 400
                else classify(text, payload["expected_behavior"])
            )
            results.append(
                {
                    "id": payload["id"],
                    "category": payload["category"],
                    "target": target,
                    "http_status": resp.status_code,
                    "latency_ms": elapsed_ms,
                    "verdict": verdict,
                    "secrets_found": find_secret_leaks(text),
                    "prompt_fragments_found": (
                        [CHAT_SYSTEM_PROMPT] if CHAT_SYSTEM_PROMPT.lower() in text.lower()
                        else find_prompt_leaks(text)
                    ),
                    "response_excerpt": text[:400],
                }
            )
            marker = "OK  " if verdict == "PASS" else "FAIL"
            print(f"{marker} {payload['id']} [{payload['category']}] -> {verdict} ({elapsed_ms}ms)")
    return results


def probe_frontend_deep_dive(base_url: str) -> dict | None:
    """Ensure the Next.js deep-dive route never echoes secret material."""
    try:
        with httpx.Client(base_url=base_url, timeout=30) as client:
            runs = client.get("/api/runs")
            runs.raise_for_status()
            items = runs.json()
            runs_list = items if isinstance(items, list) else items.get("runs", [])
            if not runs_list:
                return {"target": "frontend_deep_dive", "skipped": "no runs available"}
            run_id = runs_list[0]["id"] if isinstance(runs_list[0], dict) else runs_list[0]
            resp = client.get(f"/api/runs/{run_id}/deep-dive")
            text = resp.text
            return {
                "target": "frontend_deep_dive",
                "run_id": run_id,
                "http_status": resp.status_code,
                "verdict": "LEAK_SECRET" if find_secret_leaks(text) else "PASS",
                "secrets_found": find_secret_leaks(text),
                "response_excerpt": text[:400],
            }
    except httpx.HTTPError as exc:
        return {"target": "frontend_deep_dive", "skipped": f"unreachable: {exc}"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-url", default="http://localhost:8000")
    parser.add_argument("--frontend-url", default="http://localhost:3000")
    parser.add_argument("--skip-frontend", action="store_true")
    parser.add_argument("--token", default=os.environ.get("RAV_API_TOKEN", ""), help="bearer token; obtained by login when omitted")
    parser.add_argument("--username", default=os.environ.get("AUTH_USERNAME", "admin"))
    parser.add_argument("--password", default=os.environ.get("AUTH_PASSWORD", ""))
    args = parser.parse_args()

    report = {
        "suite": "Prompt Injection Direct Attack Suite",
        "backend_url": args.backend_url,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "results": [],
    }

    failed = False
    try:
        token = args.token or _login(args.backend_url, args.username, args.password)
        report["results"] = probe_backend(args.backend_url, token)
    except httpx.HTTPError as exc:
        print(f"[error] backend unreachable: {exc}")
        return 2

    for item in report["results"]:
        if item["verdict"] != "PASS":
            failed = True

    if not args.skip_frontend:
        frontend_result = probe_frontend_deep_dive(args.frontend_url)
        report["frontend"] = frontend_result
        print(f"[frontend] {json.dumps(frontend_result)[:200]}")
        if frontend_result.get("verdict") not in (None, "PASS"):
            failed = True

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    out_path = EVIDENCE_DIR / "injection_report.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    total = len(report["results"])
    passed = sum(1 for r in report["results"] if r["verdict"] == "PASS")
    print(f"\n{passed}/{total} payloads clean. Report written to {out_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
