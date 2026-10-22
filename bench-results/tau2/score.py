"""Recompute the published tau2 scores from the raw result files next to this script.

    python bench-results/tau2/score.py

A task passes when tau2 gave it the full reward (1.0), the benchmark's own pass^1.
"""
import gzip
import json
from pathlib import Path

EXPECTED = {
    "airline-cinderpaw-2026-09-02": (45, 50),
    "airline-reference-agent-2026-09-02": (41, 50),
    "telecom-cinderpaw-2026-09-02": (113, 114),
    "retail-cinderpaw-2026-09-10": (89, 114),
}

ok = True
for path in sorted(Path(__file__).parent.glob("*.json.gz")):
    name = path.name.removesuffix(".json.gz")
    sims = json.loads(gzip.decompress(path.read_bytes()))["simulations"]
    passed = sum(1 for s in sims if (s.get("reward_info") or {}).get("reward", 0) >= 0.999)
    match = EXPECTED.get(name) == (passed, len(sims))
    ok &= match
    print(f"{name}: {passed}/{len(sims)} = {passed / len(sims):.1%}  {'matches' if match else 'DIFFERS from the published number'}")
raise SystemExit(0 if ok else 1)
