"""RAV-13 diagnostics CLI.

Thin second interface over :mod:`src.services` — every command calls the
service layer directly (no HTTP), so results match the web API exactly.

Script-friendly by default: JSON on stdout, errors on stderr, exit code 0 on
success, 1 on runtime errors and 2 on usage errors. Pass ``-o table`` for a
human-readable layout.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from itertools import chain
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence

from src.services import run_store
from src.services.analysis import _anomaly_summaries, run_analysis
from src.services.bag_stream import iter_bag_messages
from src.services.diagnostics import detect_anomalies, parse_mcap_file, parse_rosbag2_db3
from src.services.diagnostics_config import (
    DEFAULT_DIAGNOSTICS_THRESHOLDS,
    get_diagnostics_thresholds,
    save_diagnostics_thresholds,
)
from src.services.experiments import (
    delete_experiment,
    experiment_bag_files,
    list_experiments,
    save_uploaded_rosbag,
)
from src.services.hilt_store import HILT_LABELS, append_hilt_review, list_hilt_reviews
from src.services.llm import chat_completion, explain_diagnostics, is_llm_configured
from src.services.window_export import export_windowed_jsonl, iter_window_jsonl_lines

_CHAT_SYSTEM_PROMPT = (
    "You are a robotics diagnostics assistant for the RAV-13 platform. "
    "Answer concisely and only from the data provided in this conversation."
)

_FEEDBACK_CHOICES = {"1": "correct", "2": "wrong", "3": "partial"}


def _error(message: str) -> None:
    print(f"rav13: error: {message}", file=sys.stderr)


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _print_table(rows: Sequence[Mapping[str, Any]], columns: Sequence[str]) -> None:
    if not rows:
        print("(empty)")
        return
    widths = {column: len(column) for column in columns}
    for row in rows:
        for column in columns:
            widths[column] = max(widths[column], len(_cell(row.get(column))))
    print("  ".join(column.ljust(widths[column]) for column in columns))
    print("  ".join("-" * widths[column] for column in columns))
    for row in rows:
        print("  ".join(_cell(row.get(column)).ljust(widths[column]) for column in columns))


def _emit(
    args: argparse.Namespace,
    data: Any,
    table_rows: Sequence[Mapping[str, Any]] | None = None,
    table_columns: Sequence[str] | None = None,
) -> None:
    """Print `data` as JSON, or `table_rows`/`data` as a plain-text table."""
    if args.output != "table":
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    if table_rows is not None and table_columns is not None:
        _print_table(table_rows, table_columns)
    elif isinstance(data, list) and all(isinstance(row, dict) for row in data):
        columns = list(data[0].keys()) if data else []
        _print_table(data, columns)
    elif isinstance(data, dict):
        for key, value in data.items():
            print(f"{key}: {_cell(value)}")
    else:
        print(_cell(data))


def _emit_diagnostics(args: argparse.Namespace, result: dict[str, Any]) -> None:
    if args.output != "table":
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    summary = result["summary"]
    print(
        f"messages={summary['total_messages']} detections={summary['total_detections']} severity={summary['severity']}"
    )
    _print_table(result["detections"], ["kind", "topic", "severity", "confidence"])


def _emit_run_payload(args: argparse.Namespace, payload: dict[str, Any]) -> None:
    if args.output != "table":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    run = payload["run"]
    print(
        f"run {run['id']}: status={run['status']} stage={run['stage']} "
        f"anomalies={run['anomalyCount']} worst={run['worstSeverity']} "
        f"model={run['model']} latency={run['totalLatencyMs']}ms"
    )
    _print_table(payload["anomalies"], ["id", "kind", "severity", "tSec", "confidence", "title"])
    _print_table(
        payload["ai_results"],
        ["anomalyId", "model", "confidence", "reviewStatus", "rootCause"],
    )


def _parse_thresholds(pairs: Sequence[str]) -> dict[str, float]:
    parsed: dict[str, float] = {}
    for pair in pairs:
        key, _, raw = pair.partition("=")
        key = key.strip()
        if key not in DEFAULT_DIAGNOSTICS_THRESHOLDS:
            raise ValueError(f"unknown threshold: {key}")
        parsed[key] = float(raw)
    return parsed


def _ask_feedback(ai: dict[str, Any], position: int, total: int) -> tuple[str, str]:
    print(
        f"\n[{position}/{total}] {ai.get('anomalyId', '?')} "
        f"({ai.get('model', '?')}) severity={ai.get('confidence', '?')}"
    )
    print(f"prediction: {ai.get('rootCause', '')}")
    print(f"explanation: {ai.get('explanation', '')}")
    choice = input("Select feedback: 1. Correct  2. Wrong  3. Partially correct [1]: ").strip()
    label = _FEEDBACK_CHOICES.get(choice, "correct")
    comment = input("Optional comment (Enter to skip): ").strip()
    return label, comment


def _cmd_datasets(args: argparse.Namespace) -> int:
    if args.subcommand == "list":
        items = list_experiments()
        _emit(
            args,
            items,
            table_rows=[
                {
                    "id": item["id"],
                    "name": item["name"],
                    "robotType": item["robotType"],
                    "messages": item["messageCount"],
                    "durationSec": item["durationSec"],
                    "status": item["status"],
                }
                for item in items
            ],
            table_columns=["id", "name", "robotType", "messages", "durationSec", "status"],
        )
        return 0
    if args.subcommand == "upload":
        try:
            with Path(args.file).open("rb") as handle:
                item = save_uploaded_rosbag(Path(args.file).name, handle)
        except (OSError, ValueError) as exc:
            _error(f"upload failed: {exc}")
            return 1
        _emit(args, item)
        return 0
    if args.subcommand == "delete":
        if not delete_experiment(args.id):
            _error(f"dataset not found: {args.id}")
            return 1
        _emit(args, {"ok": True, "id": args.id})
        return 0
    return 2


def _cmd_diagnose(args: argparse.Namespace) -> int:
    path = Path(args.file)
    try:
        thresholds = _parse_thresholds(args.threshold or [])
    except ValueError as exc:
        _error(str(exc))
        return 2
    try:
        messages = parse_rosbag2_db3(path) if path.suffix.lower() == ".db3" else parse_mcap_file(path)
        result = detect_anomalies(messages, thresholds or None)
    except (OSError, ValueError, json.JSONDecodeError, sqlite3.DatabaseError) as exc:
        _error(str(exc))
        return 1
    _emit_diagnostics(args, result)
    return 0


def _cmd_analyze(args: argparse.Namespace) -> int:
    try:
        result = run_analysis(args.dataset_id, args.model)
    except ValueError as exc:
        _error(str(exc))
        return 1
    run = result["run"]
    payload = {
        "run": run.model_dump(),
        "anomalies": _anomaly_summaries(run.id, result["detections"]),
        "ai_results": [item.model_dump() for item in result["ai_results"]],
    }
    _emit_run_payload(args, payload)
    return 0


def _cmd_explain(args: argparse.Namespace) -> int:
    try:
        summary = json.loads(Path(args.summary_file).read_text(encoding="utf-8"))
        result = explain_diagnostics(summary)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        _error(str(exc))
        return 1
    _emit(args, result)
    return 0


def _cmd_chat(args: argparse.Namespace) -> int:
    if not is_llm_configured():
        _error("LLM is not configured (set llm_provider and credentials in .env)")
        return 1
    try:
        message = chat_completion(
            [
                {"role": "system", "content": _CHAT_SYSTEM_PROMPT},
                {"role": "user", "content": args.message},
            ]
        )
    except Exception as exc:
        _error(str(exc))
        return 1
    _emit(args, {"response": message.get("content", "")})
    return 0


def _cmd_thresholds(args: argparse.Namespace) -> int:
    if args.subcommand == "show":
        _emit(args, {"thresholds": get_diagnostics_thresholds()})
        return 0
    try:
        parsed = _parse_thresholds(args.set)
        saved = save_diagnostics_thresholds(parsed)
    except ValueError as exc:
        _error(str(exc))
        return 2
    _emit(args, {"thresholds": saved})
    return 0


def _cmd_runs(args: argparse.Namespace) -> int:
    if args.subcommand == "list":
        runs = run_store.list_runs()
        _emit(
            args,
            runs,
            table_rows=[
                {
                    "id": run["id"],
                    "rosbagName": run["rosbagName"],
                    "status": run["status"],
                    "anomalies": run["anomalyCount"],
                    "worst": run["worstSeverity"],
                    "latencyMs": run["totalLatencyMs"],
                }
                for run in runs
            ],
            table_columns=["id", "rosbagName", "status", "anomalies", "worst", "latencyMs"],
        )
        return 0
    run = run_store.get_run(args.id)
    if run is None:
        _error(f"run not found: {args.id}")
        return 1
    payload = {
        "run": run,
        "anomalies": _anomaly_summaries(args.id, run_store.get_run_anomalies(args.id)),
        "ai_results": run_store.get_run_ai_results(args.id),
    }
    _emit_run_payload(args, payload)
    return 0


def _cmd_review(args: argparse.Namespace) -> int:
    if args.subcommand == "list":
        items = run_store.list_review_items(status="pending")
        _emit(
            args,
            items,
            table_rows=[
                {
                    "id": item["id"],
                    "runId": item["runId"],
                    "anomalyId": item["anomalyId"],
                    "rootCause": item["rootCause"],
                }
                for item in items
            ],
            table_columns=["id", "runId", "anomalyId", "rootCause"],
        )
        return 0
    if run_store.get_review_item(args.id) is None:
        _error(f"review item not found: {args.id}")
        return 1
    run_store.update_review_item(
        args.id,
        verdict=args.verdict,
        reviewer=args.reviewer or "reviewer",
        notes=args.notes,
    )
    _emit(args, {"ok": True, "id": args.id, "verdict": args.verdict})
    return 0


def _cmd_export(args: argparse.Namespace) -> int:
    bag_files = experiment_bag_files(args.dataset_id)
    if not bag_files:
        _error(f"dataset not found or no bag files: {args.dataset_id}")
        return 1
    stream = chain.from_iterable(iter_bag_messages(bag) for bag in bag_files)
    if args.out:
        try:
            count = export_windowed_jsonl(stream, args.out, window_sec=args.window)
        except (OSError, ValueError) as exc:
            _error(str(exc))
            return 1
        _emit(args, {"out": args.out, "windows": count})
        return 0
    for line in iter_window_jsonl_lines(stream, window_sec=args.window):
        print(line)
    return 0


def _cmd_hilt(args: argparse.Namespace) -> int:
    if args.subcommand == "list":
        _emit(args, {"runId": args.run_id, "reviews": list_hilt_reviews(args.run_id)})
        return 0

    run = run_store.get_run(args.run_id)
    if run is None:
        _error(f"run not found: {args.run_id}")
        return 1
    ai_results = run_store.get_run_ai_results(args.run_id)
    if not ai_results:
        _error(f"run has no AI results to review: {args.run_id}")
        return 1

    if args.index is not None:
        if args.index < 1 or args.index > len(ai_results):
            _error(f"index out of range: {args.index} (1..{len(ai_results)})")
            return 2
        targets = [ai_results[args.index - 1]]
    else:
        targets = ai_results

    records: list[dict[str, Any]] = []
    for position, ai in enumerate(targets, start=1):
        prediction = str(ai.get("rootCause") or ai.get("issue") or "")
        if args.label:
            label: str = args.label
            comment: str = args.comment or ""
        else:
            label, comment = _ask_feedback(ai, position, len(targets))
        record = {"prediction": prediction, "label": label, "comment": comment}
        append_hilt_review(args.run_id, record)
        records.append(record)

    _emit(
        args,
        {"runId": args.run_id, "records": records},
        table_rows=records,
        table_columns=["prediction", "label", "comment"],
    )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rav13",
        description="RAV-13 rosbag diagnostics CLI (direct service calls, no HTTP).",
    )
    parser.add_argument(
        "-o",
        "--output",
        choices=("json", "table"),
        default="json",
        help="output format (default: json; use table for humans)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    datasets = sub.add_parser("datasets", help="manage rosbag datasets")
    datasets_sub = datasets.add_subparsers(dest="subcommand", required=True)
    datasets_sub.add_parser("list", help="list datasets")
    upload = datasets_sub.add_parser("upload", help="upload a rosbag or zip file")
    upload.add_argument("file")
    delete = datasets_sub.add_parser("delete", help="delete a dataset")
    delete.add_argument("id")

    diagnose = sub.add_parser("diagnose", help="run rule-based diagnostics on a .db3 or JSONL file")
    diagnose.add_argument("file")
    diagnose.add_argument("--threshold", action="append", metavar="KEY=VALUE", help="override a threshold (repeatable)")

    analyze = sub.add_parser("analyze", help="analyze a dataset bag and persist the run")
    analyze.add_argument("dataset_id")
    analyze.add_argument("--model", help="model label recorded on the run")

    explain = sub.add_parser("explain", help="explain a diagnostics summary JSON file via LLM")
    explain.add_argument("summary_file")

    chat = sub.add_parser("chat", help="chat with the configured LLM")
    chat.add_argument("message")

    thresholds = sub.add_parser("thresholds", help="show or update diagnostics thresholds")
    thresholds_sub = thresholds.add_subparsers(dest="subcommand", required=True)
    thresholds_sub.add_parser("show", help="show current thresholds")
    thresholds_set = thresholds_sub.add_parser("set", help="update thresholds (KEY=VALUE ...)")
    thresholds_set.add_argument("set", nargs="+", metavar="KEY=VALUE")

    runs = sub.add_parser("runs", help="list or inspect analysis runs")
    runs_sub = runs.add_subparsers(dest="subcommand", required=True)
    runs_sub.add_parser("list", help="list runs")
    runs_show = runs_sub.add_parser("show", help="show a run detail")
    runs_show.add_argument("id")

    review = sub.add_parser("review", help="list the review queue or decide on a review item")
    review_sub = review.add_subparsers(dest="subcommand", required=True)
    review_sub.add_parser("list", help="list pending review items")
    review_decide = review_sub.add_parser("decide", help="record a review decision")
    review_decide.add_argument("id")
    review_decide.add_argument("verdict", choices=("approved", "rejected", "edited"))
    review_decide.add_argument("--reviewer")
    review_decide.add_argument("--notes")

    export = sub.add_parser("export", help="export per-window bag summaries")
    export_sub = export.add_subparsers(dest="subcommand", required=True)
    export_windows = export_sub.add_parser("windows", help="export windowed JSONL summaries of a dataset")
    export_windows.add_argument("dataset_id")
    export_windows.add_argument("--window", type=float, default=10.0, help="window width in seconds")
    export_windows.add_argument("--out", help="write to file instead of stdout")

    hilt = sub.add_parser("hilt", help="human-in-the-loop review of AI predictions")
    hilt_sub = hilt.add_subparsers(dest="subcommand", required=True)
    hilt_list = hilt_sub.add_parser("list", help="list saved feedback for a run")
    hilt_list.add_argument("run_id")
    hilt_review = hilt_sub.add_parser("review", help="collect feedback for a run's AI predictions")
    hilt_review.add_argument("run_id")
    hilt_review.add_argument("--index", type=int, help="review only the Nth prediction (1-based)")
    hilt_review.add_argument(
        "--label",
        choices=tuple(sorted(HILT_LABELS)),
        help="non-interactive label (skips the prompts)",
    )
    hilt_review.add_argument("--comment", help="comment for the recorded label")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point: parse arguments, dispatch to a command handler."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    handlers: dict[str, Callable[[argparse.Namespace], int]] = {
        "datasets": _cmd_datasets,
        "diagnose": _cmd_diagnose,
        "analyze": _cmd_analyze,
        "explain": _cmd_explain,
        "chat": _cmd_chat,
        "thresholds": _cmd_thresholds,
        "runs": _cmd_runs,
        "review": _cmd_review,
        "export": _cmd_export,
        "hilt": _cmd_hilt,
    }
    handler = handlers.get(args.command)
    if handler is None:
        _error(f"unhandled command: {args.command}")
        return 2
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
