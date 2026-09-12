#!/usr/bin/env python3
"""
Merge tau2 result files that cover DIFFERENT tasks of the same benchmark.

A run cut short by the machine (out of memory, a reboot) leaves a results file
holding the tasks that finished. The rest are still worth running, and tau2
tasks are independent by construction: each one gets a fresh environment seeded
from the same db.json, so task 100 does not care whether task 3 ran an hour
earlier or in the same process. Stitching the two files back together is
resuming one run, not averaging two.

What is NOT safe is merging files that disagree about how they were measured.
The whole point of this script is the refusal below: it compares the settings
tau2 records in `info` and stops if the two runs were not the same experiment.
Merging a pinned run with an unpinned one, or two different max_steps, produces
a number that means nothing and looks exactly like a number that means
something.

    python scripts/tau2/merge_runs.py OUT.json PART1.json PART2.json [...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# The settings that make two files the same experiment. `git_commit` is
# deliberately included: a code change between halves is the one difference
# that would silently move the score.
KEYS = ("git_commit", "num_trials", "max_steps", "max_errors")


def load(p: Path) -> dict:
    with p.open(encoding="utf-8") as f:
        return json.load(f)


def fingerprint(info: dict) -> dict:
    fp = {k: info.get(k) for k in KEYS}
    user = info.get("user_info") or {}
    fp["user_llm"] = user.get("llm")
    fp["user_impl"] = user.get("implementation")
    agent = info.get("agent_info") or {}
    fp["agent_llm"] = agent.get("llm")
    fp["agent_impl"] = agent.get("implementation")
    return fp


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    out_path = Path(sys.argv[1])
    parts = [Path(a) for a in sys.argv[2:]]

    docs = [load(p) for p in parts]
    fps = [fingerprint(d.get("info") or {}) for d in docs]
    for p, fp in zip(parts[1:], fps[1:]):
        if fp != fps[0]:
            diff = {k: (fps[0].get(k), fp.get(k)) for k in fp if fp.get(k) != fps[0].get(k)}
            print(
                f"REFUSING to merge: {p.name} was not the same experiment.\n"
                f"  differs on: {json.dumps(diff, indent=2)}",
                file=sys.stderr,
            )
            return 1

    merged = dict(docs[0])
    sims: list[dict] = []
    seen: set = set()
    for p, d in zip(parts, docs):
        for s in d.get("simulations", []):
            key = (s.get("task_id"), s.get("trial"))
            if key in seen:
                # Same task twice means one of the files re-ran it. Keeping both
                # would weight that task double; picking one silently would be a
                # choice nobody made on purpose.
                print(f"REFUSING to merge: task {key[0]} (trial {key[1]}) appears twice.", file=sys.stderr)
                return 1
            seen.add(key)
            sims.append(s)

    # Tasks: the union, keyed by id, so the file still describes the whole set.
    tasks = {t["id"]: t for d in docs for t in d.get("tasks", [])}
    merged["simulations"] = sims
    merged["tasks"] = list(tasks.values())

    total = len(tasks)
    rewards = [s["reward_info"]["reward"] for s in sims]
    avg = sum(rewards) / len(rewards) if rewards else 0.0
    passed = sum(1 for r in rewards if r == 1.0)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(merged, f)

    print(f"merged {len(parts)} files -> {out_path}")
    print(f"  simulations {len(sims)} of {total} tasks")
    print(f"  avg reward  {avg:.4f}")
    print(f"  passed      {passed}/{len(sims)} ({100 * passed / len(sims):.1f}%)")
    if len(sims) != total:
        print(f"  INCOMPLETE: {total - len(sims)} task(s) still missing — this is not a full result.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
