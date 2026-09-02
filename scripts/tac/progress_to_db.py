#!/usr/bin/env python3
"""
Turn the TAC runner's progress stream into the artifact monitor's rows.

The live page cannot reach this machine: the claude.ai viewer sandbox blocks
fetch to every host, loopback included, so a page that polls the runner is not
a thing that can be built. What works is the other direction — the session
driving the benchmark writes into the artifact's document store, and every open
view is subscribed. This script is the adapter between the two, so pushing an
update costs one read of the JSONL and one batch write instead of hand-assembly.

`run_tac.py --progress` already writes one explicitly-flushed JSON line per
event, which is the half that had to exist first: tau2 buffered its whole
output and its log file stayed empty until the process exited, so anything
scraping stdout would have shown nothing all run and looked fine in testing.

    python scripts/tac/progress_to_db.py bench-results/tac-smoke/progress.jsonl

Prints the JSON array to hand to the Artifact tool's `write_db` batch.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path


# Event name -> the phase whose clock it closes. `init` resets only the
# services a task declares, which is why it is ~45 s for a chat task and
# ~11 min for anything touching GitLab; keeping the three phases apart is
# what makes that visible instead of averaged into one number.
#
# The names come from the `prog.emit(event=...)` calls in run_tac.py, not from
# reading one run's output — a partial run does not contain the events for the
# paths it never took, and guessing from it produced a bridge that silently
# dropped every completed and every failed task.
PHASE_DONE = {"init_done": "init", "agent_done": "agent"}
PHASE_START = {"init_start": "init", "grade_start": "grade"}


def events(path: Path) -> list[dict]:
    """Parsed events belonging to the CURRENT run.

    The progress file is opened for append, so pointing two runs at the same
    `--outputs` directory leaves both of their streams in it, oldest first.
    Folding the whole file then mixes them: a finished older run marks the live
    one as finished, and its durations land on tasks the live one has not
    reached. Everything before the last `run_start` is a previous run.
    """
    parsed: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a torn last line while the runner is mid-write

    starts = [i for i, ev in enumerate(parsed) if ev.get("event") == "run_start"]
    return parsed[starts[-1]:] if starts else parsed


def fold(path: Path) -> tuple[dict, dict]:
    """Replay the stream into (run fields, {task: row})."""
    run: dict = {}
    tasks: dict[str, dict] = {}
    order = 0

    for ev in events(path):
        kind = ev.get("event")
        if kind == "run_start":
            run["started_at"] = ev.get("ts")
            run.update({
                "agent_model": ev.get("agent_model"),
                "env_llm_model": ev.get("env_llm_model"),
                "provider_pin": ev.get("provider_pin"),
                "home": ev.get("home"),
                "tasks_total": ev.get("tasks"),
            })
            continue
        if kind == "run_done":
            run["finished_at"] = stamp(ev.get("ts"))
            continue

        task = ev.get("task")
        if not task:
            continue
        row = tasks.get(task)
        if row is None:
            order += 1
            row = {"task": task, "order": order}
            tasks[task] = row

        # Absolute timestamps, not just durations: the view draws the run as a
        # time axis, and it counts the CURRENT phase up in real time between
        # the session's pushes. That is the same clock, not an invented one --
        # a bar that animates on its own between updates would be showing
        # progress nobody measured.
        if kind == "task_start":
            row["phase"] = "init"
            row["phase_started_at"] = ev.get("ts")
        elif kind in PHASE_START:
            row["phase"] = PHASE_START[kind]
            row["phase_started_at"] = ev.get("ts")
            row[PHASE_START[kind] + "_started_at"] = ev.get("ts")
            if kind == "grade_start":
                row["_grade_started"] = ev.get("ts")
        elif kind in PHASE_DONE:
            phase = PHASE_DONE[kind]
            row[phase + "_seconds"] = ev.get("seconds")
            row.setdefault(phase + "_started_at", (ev.get("ts") or 0) - (ev.get("seconds") or 0))
            # The services this task's environment actually resets, straight
            # from its dependencies.yml. Task-name prefixes do NOT track them:
            # `pm-` tasks touch Plane, GitLab or RocketChat depending on which.
            if ev.get("services"):
                row["services"] = ev["services"]
            # The agent leg records HOW it ended. "sidecar_exited" is not the
            # same outcome as finishing, and folding it into a duration hides
            # the one number worth chasing.
            if phase == "agent" and ev.get("stop_reason"):
                row["stop_reason"] = ev["stop_reason"]
        elif kind == "task_done":
            # `result` and `total` arrive flat, not as a nested score object.
            row["score"] = {"result": ev.get("result"), "total": ev.get("total")}
            row["grade_seconds"] = elapsed_since(row.pop("_grade_started", None), ev.get("ts"))
            row["phase"] = None
            row["phase_started_at"] = None
            row["ended_at"] = ev.get("ts")
        elif kind == "task_failed":
            row["error"] = str(ev.get("error") or "task failed to run")[:600]
            row["grade_seconds"] = elapsed_since(row.pop("_grade_started", None), ev.get("ts"))
            row["phase"] = None
            row["phase_started_at"] = None
            row["ended_at"] = ev.get("ts")

    return run, tasks


def elapsed_since(started: float | None, now: float | None) -> float | None:
    """Grading has no `*_done` event, so its clock is the gap to `grade_start`."""
    if not started or not now:
        return None
    return round(max(0.0, now - started), 1)


def stamp(ts: float | None) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts or time.time()))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    path = Path(argv[1])
    if not path.is_file():
        print(f"no progress stream at {path}", file=sys.stderr)
        return 2

    run, tasks = fold(path)
    run["updated_at"] = stamp(None)

    writes = [{"op": "set", "collection": "run", "doc_id": "state", "data": run}]
    for name, row in tasks.items():
        writes.append({"op": "set", "collection": "tasks", "doc_id": name,
                       "data": {k: v for k, v in row.items() if v is not None}})
    # 50 writes per batch is the ceiling; a 175-task run needs paging.
    if len(writes) > 50:
        print(f"# {len(writes)} writes — send in pages of 50", file=sys.stderr)
    print(json.dumps(writes, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
