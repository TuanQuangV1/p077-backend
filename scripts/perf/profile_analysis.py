"""cProfile the analysis pipeline against a real dataset.

Usage:
    python scripts/perf/profile_analysis.py --dataset test_minimal --view
    python scripts/perf/profile_analysis.py --dataset C_02_0 --output perf_analysis.prof

The profile is dumped to ``--output`` for snakeviz:

    python -m pip install snakeviz
    snakeviz perf_analysis.prof
"""

from __future__ import annotations

import argparse
import cProfile
import pstats
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from src.services.analysis import run_analysis  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Profile run_analysis with cProfile.")
    parser.add_argument("--dataset", default="test_minimal", help="Dataset id under data/")
    parser.add_argument("--output", default=str(REPO_ROOT / "perf_analysis.prof"))
    parser.add_argument("--view", action="store_true", help="Print the top cumulative-time stats")
    args = parser.parse_args()

    profiler = cProfile.Profile()
    profiler.enable()
    run_analysis(args.dataset)
    profiler.disable()

    output = Path(args.output)
    profiler.dump_stats(str(output))
    print(f"profile written to {output}")

    if args.view:
        stats = pstats.Stats(profiler).sort_stats("cumtime")
        stats.print_stats(40)


if __name__ == "__main__":
    main()
