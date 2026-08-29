"""
Run tau2-bench with Cinderpaw as the agent.

    # smoke test: one task, watch it work
    python scripts/tau2/run_tau2.py --num-tasks 1

    # the paired shape check from the checkpoint: same 5 tasks, both agents,
    # same day, both numbers ours
    python scripts/tau2/run_tau2.py --num-tasks 5
    python scripts/tau2/run_tau2.py --num-tasks 5 --agent llm_agent

    # the full published comparison (50 tasks, ~$0.30-1.00)
    python scripts/tau2/run_tau2.py

Runs against the clone in vendor/tau2-bench, which is gitignored — it carries
its own git history and a .env with live keys. Set TAU2_ROOT to point somewhere
else.

WINDOWS, three traps already paid for (see CHECKPOINT_20260829_TAU2_BENCH.md):
  - tau2 imports `audioop` unconditionally via its voice path; that module left
    the stdlib in 3.13, so the environment must be Python 3.12.
  - `rich` printing to a cp1252 console dies on the arrows in tau2's output.
    PYTHONUTF8/PYTHONIOENCODING are set below rather than left to the caller.
  - tau2 reads keys from `.env`, not the OS keychain.

The route Cinderpaw itself uses is separate from the one tau2 uses for the user
simulator, and both must be set:
    CINDERPAW_BASE_URL / CINDERPAW_MODEL / CINDERPAW_API_KEY   -> the agent
    OPENROUTER_API_KEY / GEMINI_API_KEY (in .env)              -> tau2's user
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

# Set before anything imports rich or loguru — see the header.
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

REPO_ROOT = Path(__file__).resolve().parents[2]
TAU2_ROOT = Path(os.environ.get("TAU2_ROOT", REPO_ROOT / "vendor" / "tau2-bench"))

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cinderpaw_agent import create_cinderpaw_agent  # noqa: E402


def _seed_cinderpaw_route() -> None:
    """
    Point Cinderpaw at the same OpenRouter key tau2 is already using.

    tau2 reads its keys from `<TAU2_ROOT>/.env` (not the OS keychain — that is
    one of the Windows traps in the header). Cinderpaw reads a different set of
    variable names for the same account, so without this a person has to find,
    export and keep in sync one credential under two names, and the failure when
    they don't is "Inference unavailable" on every task — which looks like a
    broken agent, not a missing export.

    Anything already exported wins, so pointing the agent at a different
    provider than the user simulator stays a matter of setting the variables.
    """
    env_path = TAU2_ROOT / ".env"
    if not env_path.is_file():
        return
    values: dict[str, str] = {}
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        values[k.strip()] = v.strip().strip('"').strip("'")

    key = values.get("OPENROUTER_API_KEY")
    if key:
        os.environ.setdefault("CINDERPAW_API_KEY", key)
        os.environ.setdefault("CINDERPAW_BASE_URL", "https://openrouter.ai/api/v1")
        os.environ.setdefault("CINDERPAW_PROVIDER", "openai_compatible")
        # Default the agent to the same model the published baseline was run
        # with, so the comparison is about the scaffold, not the model.
        os.environ.setdefault("CINDERPAW_MODEL", "z-ai/glm-5.3-flash")

    # The sidecar builds `${base}/v1/chat/completions` itself, while every
    # provider documents its base URL WITH the /v1 — so the obvious value
    # produces /v1/v1/... and a 404 on every single turn. The Rust host does
    # this trim before spawning the sidecar; anything else that spawns it
    # directly inherits the job. Applied to whatever is set, not just the
    # default above: a caller exporting the documented URL hits the same wall.
    base = os.environ.get("CINDERPAW_BASE_URL")
    if base:
        os.environ["CINDERPAW_BASE_URL"] = re.sub(r"/v1$", "", base.rstrip("/"))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--domain", default="airline")
    p.add_argument("--agent", default="cinderpaw", help="cinderpaw | llm_agent")
    p.add_argument("--num-tasks", type=int, default=None, help="default: all of them")
    p.add_argument(
        "--task-ids",
        nargs="+",
        default=None,
        help=(
            "Run specific tasks by id. Needed to exercise the write path on "
            "purpose: only 26 of the 50 airline tasks expect a MUTATING action, "
            "and a run of the early ones can pass end-to-end without any tool "
            "call ever having to survive the trajectory replay."
        ),
    )
    p.add_argument("--num-trials", type=int, default=1)
    p.add_argument("--max-concurrency", type=int, default=1)
    p.add_argument(
        "--max-steps",
        type=int,
        default=200,
        help=(
            "Message transfers before the run is terminated and scored ZERO. "
            "tau2's own two defaults disagree (orchestrator 100, CLI 200) and "
            "OpenRouter does not publish the one behind the 77.3%% baseline — "
            "so whatever is used here has to be stated wherever the number is."
        ),
    )
    p.add_argument(
        "--user-llm",
        default="gemini/gemini-2.5-flash",
        help="Pinned by the published leaderboard; changing it breaks comparability.",
    )
    p.add_argument(
        "--llm-agent",
        default="openrouter/z-ai/glm-5.3-flash",
        help="Only used by --agent llm_agent. Cinderpaw reads CINDERPAW_MODEL.",
    )
    args = p.parse_args()

    if not TAU2_ROOT.is_dir():
        print(f"tau2 not found at {TAU2_ROOT}. Clone it there or set TAU2_ROOT.", file=sys.stderr)
        return 2

    if args.agent == "cinderpaw":
        _seed_cinderpaw_route()
        missing = [
            k for k in ("CINDERPAW_BASE_URL", "CINDERPAW_MODEL", "CINDERPAW_API_KEY")
            if not os.environ.get(k)
        ]
        if missing:
            # Without this the sidecar comes up on its local default and every
            # task fails as "Inference unavailable" — a harness failure that
            # reads exactly like an agent failure.
            print(
                "Cinderpaw has no model route. Missing: " + ", ".join(missing) + "\n"
                "  e.g. CINDERPAW_BASE_URL=https://openrouter.ai/api/v1 "
                "CINDERPAW_MODEL=z-ai/glm-5.3-flash CINDERPAW_API_KEY=sk-or-...",
                file=sys.stderr,
            )
            return 2

    from tau2.data_model.simulation import TextRunConfig
    from tau2.registry import registry
    from tau2.runner.batch import run_domain

    registry.register_agent_factory(create_cinderpaw_agent, "cinderpaw")

    results = run_domain(
        TextRunConfig(
            domain=args.domain,
            agent=args.agent,
            llm_agent=args.llm_agent,
            llm_user=args.user_llm,
            num_trials=args.num_trials,
            num_tasks=args.num_tasks,
            task_ids=args.task_ids,
            max_concurrency=args.max_concurrency,
            max_steps=args.max_steps,
        )
    )

    sims = results.simulations
    rewards = [s.reward_info.reward for s in sims if s.reward_info is not None]
    scored = len(rewards)
    passed = sum(1 for r in rewards if r >= 1.0)

    print()
    print(f"agent      {args.agent}")
    print(f"domain     {args.domain}   max_steps {args.max_steps}")
    print(f"tasks      {passed}/{scored} passed" + (f"  ({passed / scored:.1%})" if scored else ""))
    # Termination reasons are the diagnosis, not decoration: a wall of
    # MAX_STEPS means the cap was the binding constraint and the score says
    # nothing about whether the agent knew the answer.
    reasons: dict[str, int] = {}
    for s in sims:
        reasons[str(s.termination_reason)] = reasons.get(str(s.termination_reason), 0) + 1
    for reason, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  {reason}: {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
