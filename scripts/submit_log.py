#!/usr/bin/env python3
"""
Submit .ai-log/session.jsonl to grading server.
Called by git pre-push hook or manually.

After a successful submit, the live log is rotated:
  - Moved into .ai-log/archive/YYYY-MM-DD.jsonl (appended, never overwritten)
  - The live session.jsonl is recreated empty by the next hook write

If the POST fails, the pending file is restored so nothing is lost.
"""
import json
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

SERVER_URL = os.environ.get("AI_LOG_SERVER", "")
API_KEY = os.environ.get("AI_LOG_API_KEY", "")
LOG_DIR = Path(os.environ.get("AI_LOG_DIR", ".ai-log"))
LOG_FILE = LOG_DIR / "session.jsonl"
ARCHIVE_DIR = LOG_DIR / "archive"

## Tăng BATCH_LIMIT lên 100 để giảm số lượng request và tăng tốc độ đẩy log
BATCH_LIMIT = 100
MAX_RETRIES = 4


def _validate_server_url(raw: str) -> str:
    """Allow only http/https URLs. urllib also supports file://, which could
    read arbitrary files if AI_LOG_SERVER were ever attacker-controlled, so
    the scheme is checked before any request is made."""
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(
            f"AI_LOG_SERVER must be an http(s) URL, got scheme={parsed.scheme!r}"
        )
    return raw


def _archive(pending: Path) -> None:
    """Append pending file to today's archive. Never overwrites existing data."""
    if not pending.exists() or pending.stat().st_size == 0:
        return
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    archive_file = ARCHIVE_DIR / f"{today}.jsonl"
    with open(pending, "rb") as src, open(archive_file, "ab") as dst:
        shutil.copyfileobj(src, dst)


def _restore_pending(pending: Path) -> None:
    """Failure path: put pending back at LOG_FILE so the next push retries.
    If hook wrote new entries to LOG_FILE in the meantime, prepend pending."""
    if not pending.exists():
        return
    if LOG_FILE.exists():
        # Concat: pending (older) + LOG_FILE (newer) → LOG_FILE
        tmp = LOG_FILE.with_suffix(".merge.jsonl")
        with open(tmp, "wb") as out:
            with open(pending, "rb") as a:
                shutil.copyfileobj(a, out)
            with open(LOG_FILE, "rb") as b:
                shutil.copyfileobj(b, out)
        os.replace(tmp, LOG_FILE)
        pending.unlink()
    else:
        pending.rename(LOG_FILE)


import argparse

def _send_batch(server_url: str, entries: list[dict]) -> bool:
    payload = json.dumps({"entries": entries}, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    req = urllib.request.Request(
        server_url,
        data=payload,
        headers=headers,
        method="POST",
    )

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                print(f"[ai-log] Submitted {len(entries)} entries → {resp.status}", file=sys.stderr)
                return True
        except urllib.error.HTTPError as e:
            # 429 Too Many Requests: Xử lý êm, tự động chờ theo rate-limit
            if e.code == 429:
                retry_after = e.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else (1.5 * attempt)
                time.sleep(delay)
            else:
                if attempt == MAX_RETRIES:
                    return False
                time.sleep(1.0)
        except (TimeoutError, urllib.error.URLError):
            if attempt == MAX_RETRIES:
                return False
            time.sleep(1.0 * attempt)
        except Exception:
            return False
    return False


def _submit_file(server_url: str, file_path: Path, delete_on_success: bool = False) -> None:
    if not file_path.exists() or file_path.stat().st_size == 0:
        return

    entries = []
    with open(file_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                entries.append(json.loads(stripped))
            except json.JSONDecodeError:
                pass

    if not entries:
        return

    print(f"[ai-log] Processing {len(entries)} entries from {file_path.name}...", file=sys.stderr)
    success_all = True
    for i in range(0, len(entries), BATCH_LIMIT):
        batch = entries[i : i + BATCH_LIMIT]
        success = _send_batch(server_url, batch)
        if not success:
            success_all = False
        time.sleep(0.1)

    if delete_on_success and success_all:
        file_path.unlink(missing_ok=True)


def resync_all(server_url: str) -> None:
    print("[ai-log] Resyncing all archived and session logs to grading server...", file=sys.stderr)
    all_files = sorted(ARCHIVE_DIR.glob("*.jsonl"))
    if LOG_FILE.exists():
        all_files.append(LOG_FILE)

    if not all_files:
        print("[ai-log] No logs found in archive or session.", file=sys.stderr)
        return

    total_submitted = 0
    for f in all_files:
        _submit_file(server_url, f, delete_on_success=False)
    print("[ai-log] Resync completed successfully!", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Submit AI logs to grading server / Phoenix.")
    parser.add_argument("--resync-all", action="store_true", help="Resync all history from .ai-log/archive/*.jsonl")
    parser.add_argument("--file", type=str, help="Submit a specific .jsonl file directly")
    args = parser.parse_args()

    if not SERVER_URL:
        print("[ai-log] AI_LOG_SERVER not set — skipping submission.", file=sys.stderr)
        sys.exit(0)

    try:
        server_url = _validate_server_url(SERVER_URL)
    except ValueError as e:
        print(f"[ai-log] {e} — skipping submission.", file=sys.stderr)
        sys.exit(0)

    if args.resync_all:
        resync_all(server_url)
        return

    if args.file:
        target = Path(args.file)
        _submit_file(server_url, target, delete_on_success=False)
        return

    if not LOG_FILE.exists() or LOG_FILE.stat().st_size == 0:
        print("[ai-log] No logs to submit.", file=sys.stderr)
        sys.exit(0)

    # Standard pre-push / session submit path
    pending = LOG_FILE.with_name(f"session.pending.{int(time.time())}.jsonl")
    try:
        LOG_FILE.rename(pending)
    except FileNotFoundError:
        print("[ai-log] No logs to submit.", file=sys.stderr)
        sys.exit(0)

    entries = []
    leftover_lines = []
    with open(pending, encoding="utf-8", errors="replace") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            if len(entries) >= BATCH_LIMIT:
                leftover_lines.append(line)
                continue
            try:
                entries.append(json.loads(stripped))
            except json.JSONDecodeError:
                pass

    if not entries:
        _archive(pending)
        pending.unlink(missing_ok=True)
        print("[ai-log] No valid entries to submit.", file=sys.stderr)
        sys.exit(0)

    success = _send_batch(server_url, entries)
    if not success:
        _restore_pending(pending)
        sys.exit(0)

    _archive(pending)
    pending.unlink(missing_ok=True)

    if leftover_lines:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.writelines(leftover_lines)
        print(f"[ai-log] {len(leftover_lines)} entries deferred to next push.", file=sys.stderr)


if __name__ == "__main__":
    main()
