"""Per-fault LLM-vs-ground-truth evaluation over the labelled bag corpus.

Reuses the cached detections produced by scripts/eval_root_cause.py, then calls
the real LLM once per cluster and records, for every injected fault, what the
model concluded next to what was actually injected.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

_EVAL_THRESHOLDS = REPO / "data" / "diagnostics" / "eval_thresholds.json"
os.environ["DIAGNOSTICS_THRESHOLDS_FILE"] = str(_EVAL_THRESHOLDS)

from src.services.analysis import _cascade_fragment_clusters, _cluster_detections  # noqa: E402
from src.services.llm import explain_detection_cluster, resolved_model_name  # noqa: E402
from src.config import get_settings  # noqa: E402

BAGS = Path.home() / "ros2_doctor_ws" / "bags"
CACHE = REPO / "data" / "diagnostics" / "eval_detections.json"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "data" / "diagnostics" / "per_fault_results.json"

MATCH_TOLERANCE_SEC = 10.0


def ground_truth(name: str) -> dict[str, Any]:
    group = "healthy" if name.startswith("healthy") else "faulty"
    return json.loads((BAGS / group / f"{name}_ground_truth.json").read_text(encoding="utf-8"))


def main() -> int:
    data = json.loads(CACHE.read_text(encoding="utf-8"))
    settings = get_settings()
    results: dict[str, Any] = {
        "model": resolved_model_name(settings),
        "provider": settings.llm_provider,
        "bags": {},
    }
    total_cost_tokens = {"prompt": 0, "completion": 0}

    for name in sorted(data):
        rec = data[name]
        gt = ground_truth(name)
        detections = rec["detections"]
        recording = rec.get("recording")
        clusters = _cluster_detections(detections)
        fragments = _cascade_fragment_clusters(detections, clusters)
        bag_out: dict[str, Any] = {
            "healthy": rec["healthy"],
            "description": gt.get("description", ""),
            "detection_count": len(detections),
            "clusters": [],
            "faults": [],
        }

        for index, cluster in enumerate(clusters):
            members = [detections[p] for p in cluster]
            entry: dict[str, Any] = {
                "index": index,
                "fragment": index in fragments,
                "members": [
                    {
                        "topic": m.get("topic"),
                        "kind": m.get("kind"),
                        "severity": m.get("severity"),
                        "tSec": round(float(m.get("tSec", 0.0)), 2),
                        "endSec": round(float(m.get("endSec", m.get("tSec", 0.0))), 2),
                        "detail": m.get("detail") or m.get("message") or "",
                    }
                    for m in members
                ],
            }
            if index in fragments:
                bag_out["clusters"].append(entry)
                continue
            explanation = explain_detection_cluster(members, recording=recording)
            findings = explanation.get("findings", {})
            primaries = [
                members[offset - 1].get("topic")
                for offset, finding in findings.items()
                if finding.get("role") == "primary"
            ]
            usage = explanation.get("usage", {})
            total_cost_tokens["prompt"] += int(usage.get("prompt_tokens", 0) or 0)
            total_cost_tokens["completion"] += int(usage.get("completion_tokens", 0) or 0)
            entry.update(
                {
                    "primary_topics": primaries,
                    "root_cause": explanation.get("root_cause", ""),
                    "explanation": explanation.get("explanation", ""),
                    "recommended_actions": explanation.get("recommended_actions", []),
                    "findings": {
                        str(off): {
                            "topic": members[off - 1].get("topic"),
                            "role": f.get("role"),
                            "detail": f.get("detail", ""),
                        }
                        for off, f in findings.items()
                    },
                    "span": [
                        round(min(float(m.get("tSec", 0.0)) for m in members), 2),
                        round(max(float(m.get("endSec", m.get("tSec", 0.0))) for m in members), 2),
                    ],
                }
            )
            bag_out["clusters"].append(entry)

        # Match every injected fault to the cluster conclusions.
        gt_faults = {f["id"]: f for f in gt.get("faults", [])}
        for fault in rec["faults"]:
            src = gt_faults.get(fault["id"], {})
            expected = src.get("expected_anomaly", {})
            targets = set(fault["target_topics"])
            matched, overlapping = [], []
            for entry in bag_out["clusters"]:
                if entry.get("fragment"):
                    continue
                start, end = entry["span"]
                if end < fault["start_sec"] - MATCH_TOLERANCE_SEC or start > fault["end_sec"] + MATCH_TOLERANCE_SEC:
                    continue
                overlapping.append(entry["index"])
                if set(entry.get("primary_topics") or []) & targets:
                    matched.append(entry["index"])
            bag_out["faults"].append(
                {
                    "id": fault["id"],
                    "group": fault["group"],
                    "type": src.get("type", ""),
                    "target_topics": sorted(targets),
                    "window": [round(fault["start_sec"], 2), round(fault["end_sec"], 2)],
                    "expected_detector": expected.get("detector"),
                    "expected_severity": expected.get("severity"),
                    "expected_root_cause": expected.get("root_cause", ""),
                    "expected_params": {
                        k: v for k, v in expected.items()
                        if k not in {"detector", "topic", "severity", "root_cause"}
                    },
                    "detected": fault["detected"],
                    "llm_matched_clusters": matched,
                    "llm_overlapping_clusters": overlapping,
                    "diagnosed": bool(matched),
                }
            )
        results["bags"][name] = bag_out
        print(f"scored {name} ({len(bag_out['clusters'])} clusters)", flush=True)

    results["tokens"] = total_cost_tokens
    OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
