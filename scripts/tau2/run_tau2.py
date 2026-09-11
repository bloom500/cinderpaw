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

# ...and then actually get UTF-8 mode, which the two lines above do NOT give us.
#
# `PYTHONUTF8` is read by the interpreter at STARTUP. Setting it in `os.environ`
# from inside a running process changes what child processes inherit and nothing
# else: this process's own `open()` keeps defaulting to the locale encoding,
# which on a Windows console is cp1252.
#
# That went unnoticed because airline's policy file is pure ASCII. The telecom
# domain's is not — `tau2/utils/io_utils.py:130` calls `open(path, "r")` with no
# encoding, and loading the telecom environment dies with
# `UnicodeDecodeError: 'charmap' codec can't decode byte 0x8f in position 1522`
# before a single task runs. Every `open()` in the vendored tree has the same
# hole; UTF-8 mode closes all of them at once, without patching a clone that is
# gitignored and would lose the patch on the next pull.
#
# So: if we are not in UTF-8 mode, restart ourselves once, in it. The child sees
# `sys.flags.utf8_mode == 1`, so this cannot loop.
#
# `subprocess` and not `os.execv`: on Windows execv re-quotes the argument list
# itself and mangles any path containing a space. This repo lives in
# "D:\Cinderpaw Agent", and the first attempt relaunched itself as
# `D:\Cinderpaw Agent\Agent\vendor\...` — a path that does not exist, reported as
# a missing file rather than as a quoting bug.
if not sys.flags.utf8_mode:
    import subprocess

    sys.exit(
        subprocess.run(
            [sys.executable, "-X", "utf8", os.path.abspath(__file__), *sys.argv[1:]],
            check=False,
        ).returncode
    )

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
        # Pin the FIRST-PARTY endpoint. One model id is 25 endpoints on
        # OpenRouter and routing moves per request, which is the confound that
        # swung identical tau2 runs by 40 points. The agent's own pin lives in
        # this env var (see openRouterProviderPin); without it Cinderpaw's arm
        # was the only unpinned thing in a benchmark that pins everything else.
        os.environ.setdefault("CINDERPAW_OPENROUTER_PROVIDER", "z-ai/fp8")

    # The sidecar builds `${base}/v1/chat/completions` itself, while every
    # provider documents its base URL WITH the /v1 — so the obvious value
    # produces /v1/v1/... and a 404 on every single turn. The Rust host does
    # this trim before spawning the sidecar; anything else that spawns it
    # directly inherits the job. Applied to whatever is set, not just the
    # default above: a caller exporting the documented URL hits the same wall.
    base = os.environ.get("CINDERPAW_BASE_URL")
    if base:
        os.environ["CINDERPAW_BASE_URL"] = re.sub(r"/v1$", "", base.rstrip("/"))


def _pin_litellm_provider(agent_model: str) -> str | None:
    """
    Apply `CINDERPAW_OPENROUTER_PROVIDER` to tau2's own model calls too.

    The env var reaches the Cinderpaw arm through the sidecar's egress layer,
    which is our code. It does NOT reach the reference `llm_agent` or the user
    simulator: both go through litellm here, inside vendored tau2. Pinning only
    our side is worse than pinning nothing — it makes the two arms differ by
    provider routing, which is the exact confound the pin exists to remove.

    `z-ai/glm-5.3-flash` is served by 22 OpenRouter endpoints, six of them
    reporting `quantization: unknown`. The same 21 telecom tasks scored 11/21
    and 20/21 unpinned.

    Scoped to `agent_model` ALONE, and that is the whole subtlety. A provider
    name is not a global setting — it names a company that serves one specific
    model. Applied to every `openrouter/*` call it also hit the user simulator,
    and OpenRouter answered `No endpoints found for google/gemini-2.5-flash`,
    because Z.AI does not serve Google's model. That killed 100 airline
    simulations at duration 0.0 before a single token was billed. The user
    simulator needs no pin anyway: `google/gemini-2.5-flash` is first-party
    only on OpenRouter (Google and Google AI Studio), which is exactly the
    routing spread the pin exists to close.

    Wraps rather than edits the vendored tree: the clone is gitignored and a
    patch there is lost on the next pull.
    """
    name = os.environ.get("CINDERPAW_OPENROUTER_PROVIDER", "").strip()
    if not name or not agent_model.startswith("openrouter/"):
        return None

    from tau2.utils import llm_utils

    inner = llm_utils.completion
    pin = {"order": [name], "allow_fallbacks": False}

    def completion_pinned(*a, **kw):
        if str(kw.get("model", "")) == agent_model:
            extra = dict(kw.get("extra_body") or {})
            extra.setdefault("provider", pin)
            kw["extra_body"] = extra
        return inner(*a, **kw)

    llm_utils.completion = completion_pinned
    return name


def _route_nl_assertion_judge(model: str) -> str:
    """
    Point the NL-assertion judge at a provider we actually hold a key for.

    Retail is the first domain here that GRADES with an LLM. 112 of its 114
    tasks carry `reward_basis: [DB, NL_ASSERTION]`, and airline's tasks carry
    nl_assertions too but never score on them, so this stayed invisible through
    two published benchmarks. tau2 hardcodes the judge as `gpt-4.1-2025-04-14`
    with no provider prefix, litellm resolves that to OpenAI, and with no
    OPENAI_API_KEY every task raised AuthenticationError, was retried three
    times, and terminated TOO_MANY_ERRORS with reward 0.00 - a harness failure
    that reads exactly like an agent that cannot do retail.

    Same rule as `--user-llm`: the MODEL is pinned by the published
    leaderboard, the PROVIDER is ours to pick. `openrouter/openai/gpt-4.1-...`
    is the same judge, billed somewhere we have credit.

    Patched in two places because `evaluator_nl_assertions` did
    `from tau2.config import DEFAULT_LLM_NL_ASSERTIONS` - it holds its OWN
    binding, so setting only `tau2.config` would change nothing.
    """
    from tau2 import config as tau2_config
    from tau2.evaluator import evaluator_nl_assertions as nl_eval

    tau2_config.DEFAULT_LLM_NL_ASSERTIONS = model
    nl_eval.DEFAULT_LLM_NL_ASSERTIONS = model
    return model


def _preflight(registry, args) -> bool:
    """
    Load the domain and print what is about to be measured, BEFORE any money is
    spent. Returns False when the run should not start.

    This exists because the telecom domain could not be loaded at all on Windows
    and nothing said so until a task tried to run. `tau2/utils/io_utils.py:130`
    opens policy files with no encoding; telecom's contains a byte cp1252 cannot
    decode. A run that dies on task 1 after the harness has already reported
    itself ready is the expensive way to find that out.

    The numbers it prints are not decoration. Airline and telecom are different
    benchmarks wearing the same name: telecom's policy is three times longer and
    76% of its graded actions are performed by the USER, not the agent.
    """
    try:
        env_kwargs = (
            {"retrieval_variant": args.retrieval_config}
            if args.retrieval_config
            else {}
        )
        env = registry.get_env_constructor(args.domain)(**env_kwargs)
    except Exception as e:  # noqa: BLE001 — the point is to report ANY failure clearly
        print(
            f"\nDomain '{args.domain}' could not be loaded: {type(e).__name__}: {e}\n"
            "  Nothing has been spent. Fix this before running.",
            file=sys.stderr,
        )
        return False

    try:
        tasks = registry.get_tasks_loader(args.domain)()
    except Exception as e:  # noqa: BLE001
        print(f"\nDomain '{args.domain}' has no loadable task set: {e}", file=sys.stderr)
        return False

    policy = env.get_policy()
    try:
        user_tools = len(env.get_user_tools())
    except Exception:
        user_tools = 0

    selected = len(tasks)
    if args.task_ids:
        selected = len(args.task_ids)
    elif args.num_tasks:
        selected = min(args.num_tasks, selected)

    print()
    print(f"preflight  domain={args.domain}  split tasks={len(tasks)}  running={selected}")
    print(f"           policy={len(policy)} chars (~{len(policy) // 4} tokens)  "
          f"agent_tools={len(env.get_tools())}  user_tools={user_tools}")

    # The policy is delivered to Cinderpaw in the FIRST USER TURN, not as a
    # system prompt (see cinderpaw_agent.py's header). A long one is the thing
    # most likely to be dropped if the sidecar ever compacts, and in a
    # manual-driven domain the policy IS the task.
    if args.agent == "cinderpaw" and len(policy) > 12_000:
        print(f"           NOTE: policy is {len(policy)} chars and rides in the first user "
              "turn. Check the trajectory for compaction before trusting the score.")

    # Whether an LLM grades this domain belongs on screen next to the score.
    # A judge is a second model in the measurement, and swapping it moves the
    # number without anything about the agent having changed.
    judged = sum(
        1 for t in tasks
        if "NL_ASSERTION" in ((getattr(t, "evaluation_criteria", None)
                               and getattr(t.evaluation_criteria, "reward_basis", None)) or [])
    )
    if judged:
        print(f"           NOTE: {judged}/{len(tasks)} tasks are graded by an LLM judge "
              f"({args.judge_llm}). Report the judge with the score.")

    # A domain where the user holds tools is measuring something else: whether
    # the agent can INSTRUCT, not whether it can act.
    if user_tools:
        print(f"           NOTE: {user_tools} user-side tools — most graded actions here are "
              "performed by the user, on the agent's instructions.")

    return True


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--domain", default="airline")
    p.add_argument(
        "--preflight-only",
        action="store_true",
        help="Load the domain, print what would be measured, and exit without running.",
    )
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
        default="openrouter/google/gemini-2.5-flash",
        # The MODEL is pinned by the published leaderboard and must not change.
        # The PROVIDER is not: routing the same gemini-2.5-flash through
        # OpenRouter instead of Google's own endpoint is a billing change, not a
        # comparability change.
        #
        # It has to be a different provider, because Google's free tier caps
        # `generate_content_free_tier_requests` at 5 requests per MINUTE for
        # this model, and telecom is unrunnable under that: 114 tasks whose
        # graded actions are mostly user-side means the user simulator is the
        # busiest caller in the harness, not the quietest. Every task died with
        # `TerminationReason.INFRASTRUCTURE_ERROR` and zero messages — the
        # first user turn never completed. Airline hid this because its
        # conversations are short enough to stay under the cap.
        help=(
            "Model pinned by the published leaderboard; changing the MODEL breaks "
            "comparability. Provider is ours to pick — Google's free tier is 5 RPM "
            "and telecom cannot run under it."
        ),
    )
    p.add_argument(
        "--judge-llm",
        default="openrouter/openai/gpt-4.1-2025-04-14",
        help=(
            "Judge for NL_ASSERTION grading (retail). Model pinned by the "
            "leaderboard; provider is ours, because tau2's bare 'gpt-4.1' needs "
            "an OpenAI key and every task fails scoring without one."
        ),
    )
    p.add_argument(
        "--retrieval-config",
        default=None,
        help=(
            "banking_knowledge only: which retrieval variant the environment "
            "builds (see RETRIEVAL_VARIANTS). Default is picked below and "
            "printed, because tau2's own default cannot be constructed without "
            "an OpenAI key."
        ),
    )
    p.add_argument(
        "--llm-agent",
        default="openrouter/z-ai/glm-5.3-flash",
        help="Only used by --agent llm_agent. Cinderpaw reads CINDERPAW_MODEL.",
    )
    args = p.parse_args()

    # tau2's default banking variant is `alltools`, whose dense half embeds all
    # 698 knowledge documents with OpenAI's text-embedding-3-large. That needs an
    # OPENAI_API_KEY, and without one the domain cannot even be CONSTRUCTED — the
    # run dies before a single task, with a bare OpenAIError. A machine that has
    # only the OpenRouter key this harness already requires gets `alltools-qwen`
    # instead: the same three tools (BM25, dense, shell), dense served by
    # qwen3-embedding-8b over OpenRouter. It is a different retrieval backend, so
    # it is printed, not silent, and it belongs next to any score from this domain.
    if args.domain == "banking_knowledge" and args.retrieval_config is None:
        openai_key = bool(os.environ.get("OPENAI_API_KEY"))
        posix = sys.platform != "win32"
        if posix:
            args.retrieval_config = "alltools" if openai_key else "alltools-qwen"
        else:
            args.retrieval_config = (
                "openai_embeddings_grep" if openai_key else "qwen_embeddings_grep"
            )
        args.retrieval_reason = (
            ("OPENAI_API_KEY set" if openai_key else "no OPENAI_API_KEY, dense via OpenRouter")
            + ("" if posix else "; no shell tool because sandbox-runtime is Linux/macOS only")
        )

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

    pinned = _pin_litellm_provider(args.llm_agent)
    if pinned:
        print(f"provider pin  {pinned} (allow_fallbacks=false) for {args.llm_agent}; user simulator left on its own routing")

    cp_pin = os.environ.get("CINDERPAW_OPENROUTER_PROVIDER")
    if args.agent == "cinderpaw" and cp_pin:
        print(f"agent pin  {cp_pin} (allow_fallbacks=false) for Cinderpaw's own model route")

    judge = _route_nl_assertion_judge(args.judge_llm)
    print(f"judge      {judge} for NL_ASSERTION grading")
    if args.retrieval_config:
        why = getattr(args, "retrieval_reason", "set explicitly with --retrieval-config")
        print(f"retrieval  {args.retrieval_config} — the knowledge tools the agent is given ({why})")

    if not _preflight(registry, args):
        return 2
    if args.preflight_only:
        return 0

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
            retrieval_config=args.retrieval_config,
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
