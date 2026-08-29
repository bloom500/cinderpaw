"""
Compare two tau2 runs of the SAME tasks, on the shape rather than the score.

At n=5 the reward is noise: one task is 20 points. So this reports the
continuous things that carry signal at this sample size, and the failure modes,
and puts reward last on purpose.

    python scripts/tau2/compare_arms.py <cinderpaw-run-dir> <llm_agent-run-dir>

Each argument is a directory under vendor/tau2-bench/data/simulations, or the
results.json inside one. With one argument it just reports that run.

WRITE OPERATIONS ARE COUNTED SEPARATELY from tool calls, because they are the
only ones that can fail the replay: tau2 grades a fresh environment rebuilt
from the trajectory, so a read that never happened costs nothing and a write
that never happened costs the whole task. "12 tool calls" and "12 tool calls,
3 of them writes, db_match True" are different claims.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

#: Airline tools that change the database. The rest are reads.
MUTATING = {
    "book_reservation",
    "cancel_reservation",
    "send_certificate",
    "update_reservation_baggages",
    "update_reservation_flights",
    "update_reservation_passengers",
}


def load(arg: str) -> dict:
    p = Path(arg)
    if p.is_dir():
        p = p / "results.json"
    return json.loads(p.read_text(encoding="utf-8"))


def summarise(results: dict) -> dict:
    rows = []
    for sim in results["simulations"]:
        calls = [tc for m in sim["messages"] for tc in (m.get("tool_calls") or [])]
        writes = [c for c in calls if c["name"] in MUTATING]
        ri = sim.get("reward_info") or {}
        db = (ri.get("db_check") or {}).get("db_match")
        rows.append(
            {
                "task": sim.get("task_id"),
                "reward": ri.get("reward"),
                "db_match": db,
                "communicate": (ri.get("reward_breakdown") or {}).get("COMMUNICATE"),
                "messages": len(sim["messages"]),
                "tool_calls": len(calls),
                "writes": len(writes),
                "termination": str(sim.get("termination_reason")),
                "duration_s": sim.get("duration"),
                "cost": sim.get("agent_cost") or sim.get("total_cost"),
            }
        )
    return {"rows": rows}


def report(name: str, s: dict) -> None:
    rows = s["rows"]
    print(f"\n=== {name} ===")
    hdr = f"{'task':>5} {'rew':>4} {'db':>5} {'comm':>5} {'msgs':>5} {'calls':>6} {'wr':>3} {'sec':>6}  termination"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        dur = f"{r['duration_s']:.0f}" if isinstance(r["duration_s"], (int, float)) else "-"
        print(
            f"{str(r['task']):>5} {str(r['reward']):>4} {str(r['db_match']):>5} "
            f"{str(r['communicate']):>5} {r['messages']:>5} {r['tool_calls']:>6} "
            f"{r['writes']:>3} {dur:>6}  {r['termination'].split('.')[-1]}"
        )
    n = len(rows) or 1
    solved = sum(1 for r in rows if (r["reward"] or 0) >= 1.0)
    dbok = sum(1 for r in rows if r["db_match"] is True)
    maxsteps = sum(1 for r in rows if "MAX_STEPS" in r["termination"])
    infra = sum(1 for r in rows if "INFRASTRUCTURE" in r["termination"])
    print(
        f"\n  solved {solved}/{len(rows)}   db_match {dbok}/{len(rows)}   "
        f"MAX_STEPS {maxsteps}   infra errors {infra}"
    )
    print(
        f"  per task: {sum(r['tool_calls'] for r in rows) / n:.1f} tool calls "
        f"({sum(r['writes'] for r in rows) / n:.1f} writes), "
        f"{sum(r['messages'] for r in rows) / n:.1f} messages"
    )
    # An infra error is not a score. Saying so here stops it being averaged in
    # silently, which is how a broken harness starts looking like a weak agent.
    if infra:
        print(f"  NOTE: {infra} run(s) failed on infrastructure — not an agent result.")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    a = summarise(load(sys.argv[1]))
    report(Path(sys.argv[1]).name, a)
    if len(sys.argv) > 2:
        b = summarise(load(sys.argv[2]))
        report(Path(sys.argv[2]).name, b)
        print(
            "\nRead the shape, not the reward: at n=5 one task is 20 points. "
            "db_match and surviving writes say whether the bridge works; "
            "tool calls and messages per task say what the scaffold costs."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
