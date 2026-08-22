"""Measure detector recall and LLM root-cause accuracy against labelled bags.

Runs the real production path — `detect_anomalies` -> `_cluster_detections` ->
`explain_detection_cluster` — over a directory of rosbags carrying
`*_ground_truth.json` siblings, and reports the metrics used to gate releases.

Two properties matter for the numbers to mean anything:

* **Threshold isolation.** A running API server can persist tuned thresholds to
  `data/diagnostics/thresholds.json` mid-run, which silently changes what the
  detector fires on. One measured run was invalidated this way (healthy-bag
  false positives jumped from 0.2 to 4.2 per bag). This script pins
  `DIAGNOSTICS_THRESHOLDS_FILE` to its own file and refuses to start if a
  different override is already in play.
* **Detector/LLM split.** Detection results are cached to disk, so clustering
  and prompt experiments can be swept offline without spending a single token.

Usage:
    python scripts/eval_root_cause.py --runs 3
    python scripts/eval_root_cause.py --detector-only     # no LLM calls
    python scripts/eval_root_cause.py --bags ~/ros2_doctor_ws/bags
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Pin thresholds before anything imports the diagnostics config.
_EVAL_THRESHOLDS = Path(__file__).resolve().parent.parent / "data" / "diagnostics" / "eval_thresholds.json"
_existing_override = os.environ.get("DIAGNOSTICS_THRESHOLDS_FILE")
if _existing_override and Path(_existing_override) != _EVAL_THRESHOLDS:
    raise SystemExit(
        f"refusing to run: DIAGNOSTICS_THRESHOLDS_FILE is already set to {_existing_override}.\n"
        "Unset it so the evaluation runs against known thresholds."
    )
os.environ["DIAGNOSTICS_THRESHOLDS_FILE"] = str(_EVAL_THRESHOLDS)

from src.services import analysis  # noqa: E402
from src.services.analysis import _cascade_fragment_clusters, _cluster_detections  # noqa: E402
from src.services.bag_stream import iter_bag_messages  # noqa: E402
from src.services.diagnostics import detect_anomalies  # noqa: E402
from src.services.llm import explain_detection_cluster, is_llm_configured  # noqa: E402

DEFAULT_BAGS = Path.home() / "ros2_doctor_ws" / "bags"
MATCH_TOLERANCE_SEC = 10.0


def _bag_dirs(root: Path) -> list[Path]:
    dirs: list[Path] = []
    for group in ("faulty", "healthy"):
        base = root / group
        if base.is_dir():
            dirs.extend(sorted(entry for entry in base.iterdir() if entry.is_dir()))
    return dirs


def _ground_truth(bag_dir: Path) -> dict[str, Any] | None:
    path = bag_dir.parent / f"{bag_dir.name}_ground_truth.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def _fault_detected(detections: list[dict[str, Any]], fault: dict[str, Any], bag_t0: float) -> bool:
    """A fault counts as detected when a detection on one of its topics overlaps its window."""
    injection = fault["injection"]
    start = injection["t_start_rel_sec"] - MATCH_TOLERANCE_SEC
    end = injection["t_end_rel_sec"] + MATCH_TOLERANCE_SEC
    targets = set(fault["target_topics"])
    for detection in detections:
        if detection.get("topic") not in targets:
            continue
        onset = float(detection.get("tSec", 0.0)) - bag_t0
        finish = float(detection.get("endSec", detection.get("tSec", 0.0))) - bag_t0
        if finish >= start and onset <= end:
            return True
    return False


def collect_detections(bag_root: Path, cache_path: Path, refresh: bool) -> dict[str, Any]:
    """Detect on every bag once and cache, so LLM sweeps never re-read bags."""
    if cache_path.exists() and not refresh:
        return json.loads(cache_path.read_text(encoding="utf-8"))

    collected: dict[str, Any] = {}
    bag_dirs = _bag_dirs(bag_root)
    for index, bag_dir in enumerate(bag_dirs, start=1):
        ground_truth = _ground_truth(bag_dir)
        if ground_truth is None:
            continue
        print(f"[detect {index}/{len(bag_dirs)}] {bag_dir.name}", flush=True)
        summary = detect_anomalies(iter_bag_messages(bag_dir))
        collected[bag_dir.name] = {
            "detections": summary.get("detections", []),
            "gt_topics": sorted({t for f in ground_truth.get("faults", []) for t in f["target_topics"]}),
            "faults": [
                {
                    "id": f["id"],
                    "group": f["group"],
                    "target_topics": f["target_topics"],
                    "start_sec": f["injection"]["t_start_rel_sec"] + ground_truth["bag_t0_sim_ns"] / 1e9,
                    "end_sec": f["injection"]["t_end_rel_sec"] + ground_truth["bag_t0_sim_ns"] / 1e9,
                    "detected": _fault_detected(
                        summary.get("detections", []), f, ground_truth["bag_t0_sim_ns"] / 1e9
                    ),
                }
                for f in ground_truth.get("faults", [])
            ],
            "healthy": bag_dir.name.startswith("healthy"),
            "recording": {
                "start_sec": float(summary.get("summary", {}).get("stream_start_sec", 0.0)),
                "end_sec": float(summary.get("summary", {}).get("stream_end_sec", 0.0)),
            },
        }
    cache_path.write_text(json.dumps(collected, ensure_ascii=False), encoding="utf-8")
    return collected


def detector_metrics(data: dict[str, Any]) -> dict[str, Any]:
    faults = [f for rec in data.values() for f in rec["faults"]]
    healthy = [rec for rec in data.values() if rec["healthy"]]
    healthy_detections = sum(len(rec["detections"]) for rec in healthy)
    return {
        "gt_faults": len(faults),
        "faults_detected": sum(1 for f in faults if f["detected"]),
        "recall_pct": 100.0 * sum(1 for f in faults if f["detected"]) / len(faults) if faults else 0.0,
        "healthy_bags": len(healthy),
        "healthy_detections": healthy_detections,
        "healthy_per_bag": healthy_detections / len(healthy) if healthy else 0.0,
    }


def clustering_metrics(data: dict[str, Any]) -> dict[str, Any]:
    """Structural quality of the payloads, measurable without calling the LLM.

    `cluster_with_gt_pct` is the ceiling on root-cause accuracy: a cluster that
    does not contain the ground-truth topic cannot yield a correct answer.
    """
    total = singleton = with_gt = 0
    for rec in data.values():
        if rec["healthy"]:
            continue
        detections = rec["detections"]
        gt_topics = set(rec["gt_topics"])
        clusters = _cluster_detections(detections)
        fragments = _cascade_fragment_clusters(detections, clusters)
        for index, cluster in enumerate(clusters):
            if index in fragments:
                continue
            total += 1
            if len(cluster) == 1:
                singleton += 1
            if {detections[p]["topic"] for p in cluster} & gt_topics:
                with_gt += 1
    return {
        "clusters": total,
        "singleton_pct": 100.0 * singleton / total if total else 0.0,
        "cluster_with_gt_pct": 100.0 * with_gt / total if total else 0.0,
    }


def llm_metrics(data: dict[str, Any]) -> dict[str, Any]:
    """Call the real LLM once per cluster and score the conclusions it returns."""
    clusters_total = clusters_correct = 0
    primary_total = primary_count = 0
    bags_total = bags_correct = 0
    run_level_correct = 0
    faults_total = faults_diagnosed = 0

    for name, rec in data.items():
        if rec["healthy"]:
            continue
        detections = rec["detections"]
        gt_topics = set(rec["gt_topics"])
        bags_total += 1
        bag_hit = False
        run_candidates: list[tuple[str, str, float]] = []
        conclusions: list[tuple[str, float, float]] = []

        clusters = _cluster_detections(detections)
        fragments = _cascade_fragment_clusters(detections, clusters)
        recording = rec.get("recording")
        for index, cluster in enumerate(clusters):
            if index in fragments:
                continue
            members = [detections[p] for p in cluster]
            explanation = explain_detection_cluster(members, recording=recording)
            findings = explanation.get("findings", {})
            primaries = [
                members[offset - 1]["topic"]
                for offset, finding in findings.items()
                if finding.get("role") == "primary"
            ]
            clusters_total += 1
            primary_total += len(members)
            primary_count += sum(1 for f in findings.values() if f.get("role") == "primary")
            if primaries and primaries[0] in gt_topics:
                clusters_correct += 1
                bag_hit = True
            if primaries:
                conclusions.append(
                    (
                        primaries[0],
                        min(float(d.get("tSec", 0.0)) for d in members),
                        max(float(d.get("endSec", d.get("tSec", 0.0))) for d in members),
                    )
                )
            worst = max(members, key=lambda d: _SEVERITY_RANK.get(str(d.get("severity", "low")), 0))
            run_candidates.append(
                (primaries[0] if primaries else "", str(worst.get("severity", "low")), float(worst.get("tSec", 0.0)))
            )

        # Per-fault coverage: does each injected fault get a conclusion of its
        # own naming its topic? Over-merged clusters produce one conclusion for
        # several faults, which `root_cause_pct` cannot see but an operator can.
        for fault in rec["faults"]:
            faults_total += 1
            targets = set(fault.get("target_topics", []))
            if any(
                topic in targets and end >= fault["start_sec"] and start <= fault["end_sec"]
                for topic, start, end in conclusions
            ):
                faults_diagnosed += 1

        if bag_hit:
            bags_correct += 1
        if run_candidates:
            chosen = max(run_candidates, key=lambda c: (_SEVERITY_RANK.get(c[1], 0), -c[2]))
            if chosen[0] in gt_topics:
                run_level_correct += 1
        print(f"  scored {name}", flush=True)

    return {
        "clusters": clusters_total,
        "root_cause_pct": 100.0 * clusters_correct / clusters_total if clusters_total else 0.0,
        "primary_rate_pct": 100.0 * primary_count / primary_total if primary_total else 0.0,
        "bag_any_correct_pct": 100.0 * bags_correct / bags_total if bags_total else 0.0,
        "run_level_pct": 100.0 * run_level_correct / bags_total if bags_total else 0.0,
        "fault_diagnosed_pct": 100.0 * faults_diagnosed / faults_total if faults_total else 0.0,
    }


_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bags", type=Path, default=DEFAULT_BAGS)
    parser.add_argument("--runs", type=int, default=1, help="LLM repetitions (release gates require >= 3)")
    parser.add_argument("--detector-only", action="store_true", help="skip all LLM calls")
    parser.add_argument("--refresh-cache", action="store_true", help="re-detect instead of reusing the cache")
    parser.add_argument("--cache", type=Path, default=Path("data/diagnostics/eval_detections.json"))
    parser.add_argument(
        "--slack",
        type=float,
        default=None,
        help="override the cluster slack in seconds, to compare a clustering change",
    )
    args = parser.parse_args()

    if args.slack is not None:
        analysis._CLUSTER_SLACK_SEC = args.slack
        print(f"cluster slack overridden to {args.slack}s")

    args.cache.parent.mkdir(parents=True, exist_ok=True)
    data = collect_detections(args.bags, args.cache, args.refresh_cache)
    if not data:
        print(f"no labelled bags found under {args.bags}", file=sys.stderr)
        return 1

    print("\n=== detector ===")
    for key, value in detector_metrics(data).items():
        print(f"{key:<24} {value:.2f}" if isinstance(value, float) else f"{key:<24} {value}")

    print("\n=== clustering (offline, no tokens) ===")
    for key, value in clustering_metrics(data).items():
        print(f"{key:<24} {value:.2f}" if isinstance(value, float) else f"{key:<24} {value}")

    if args.detector_only:
        return 0
    if not is_llm_configured():
        print("\nLLM not configured — skipping root-cause scoring.", file=sys.stderr)
        return 1

    print(f"\n=== LLM root cause ({args.runs} run(s)) ===")
    runs = [llm_metrics(data) for _ in range(args.runs)]
    for key in runs[0]:
        values = [run[key] for run in runs]
        if len(values) > 1:
            print(f"{key:<24} median={statistics.median(values):.2f}  min={min(values):.2f}  max={max(values):.2f}")
        else:
            print(f"{key:<24} {values[0]:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
