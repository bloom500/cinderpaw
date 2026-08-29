"""
Cinderpaw as a tau2-bench agent.

Lives in this repo rather than in `vendor/tau2-bench` because vendor/ is
gitignored — it is a clone with its own history and a .env full of live keys.
Register it from the runner (`run_tau2.py`), which adds this directory to the
path and calls `registry.register_agent_factory`.

────────────────────────────────────────────────────────────────────────────
HOW THE TOOL CALLS GET WHERE THEY HAVE TO GO

Cinderpaw normally runs its own tools, in-process, and hands back only the
answer. That is exactly wrong here. tau2 does not grade the environment the
agent worked in: `evaluator_env.py` builds a FRESH environment and replays the
orchestrator's recorded trajectory into it (`environment.py`, set_state), then
hashes THAT. A tool call the orchestrator never saw did not happen. An agent
executing its own tools would score zero on all 43 of the 50 airline tasks that
write anything, and pass the 7 read-only ones — looking wired up and merely
weak.

So the domain tools are declared to the sidecar as HOST tools
(CINDERPAW_HOST_TOOLS, see CinderpawAgent/src/core/host-tool-bridge.ts). When
the model calls one, the sidecar emits `tool_request` and suspends. We turn
that into an AssistantMessage carrying the tool call and hand it to the
orchestrator, which executes it against the live environment, records both
halves in the trajectory, and calls us back with the ToolMessage. We answer the
sidecar's `tool_response` and it resumes the same turn.

    sidecar --tool_request--> here --AssistantMessage(tool_calls)--> orchestrator
    sidecar <-tool_response-- here <---------- ToolMessage --------- orchestrator

A pleasant consequence: `step_count` (orchestrator.py) then counts Cinderpaw's
tool calls natively and identically to the published baseline, so there is no
mirrored step budget to maintain and no separate call count to publish
alongside the score.

────────────────────────────────────────────────────────────────────────────
WHAT IS NOT LIKE-FOR-LIKE, AND IS NOT HIDDEN

Say these next to any number this produces.

1. Cinderpaw brings its whole toolbox. The baseline agent has the 14 domain
   tools and nothing else; Cinderpaw also has files, shell, web search, memory
   and the rest. That is what Cinderpaw IS, so it is not "corrected" here — but
   it means more context per turn and more ways to wander, and it is a
   difference in the agent, not in the model.
2. The domain policy is delivered in the first user turn, delimited, rather
   than as a system prompt. The sidecar's system prompt is its own and is not
   settable over stdin. The baseline puts the policy in the system message.
3. The step limit OpenRouter used for the published run is not published. State
   whatever `--max-steps` this run used and call the delta approximate.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from queue import Empty, Queue
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from loguru import logger

from tau2.agent.base_agent import AgentError, HalfDuplexAgent
from tau2.data_model.message import (
    AssistantMessage,
    Message,
    MultiToolMessage,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from tau2.environment.toolkit import Tool

REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_ENTRY = REPO_ROOT / "CinderpawAgent" / "src" / "index.ts"

# Mirrors the instruction the baseline agent is given (llm_agent.py,
# AGENT_INSTRUCTION). Kept close on purpose: a prompt rewritten in our favour
# would be the easiest way to manufacture the difference we are trying to
# measure. The one addition is the turn rule, because tau2's orchestrator
# raises if a message carries both text and tool calls.
AGENT_INSTRUCTION = """
You are a customer service agent that helps the user according to the <policy> provided below.
In each turn you can either:
- Send a message to the user.
- Make a tool call.
You cannot do both at the same time.

Try to be helpful and always follow the policy.
""".strip()

FIRST_TURN = """<instructions>
{instruction}
</instructions>
<policy>
{policy}
</policy>

The customer's first message follows.

{message}"""


def _resolve_bun() -> str:
    """
    Absolute path to bun.

    `subprocess` without a shell cannot exec `bun.cmd`, which is what is on PATH
    on Windows — and it fails at spawn time, which reads as "the agent produced
    nothing" unless you know to look. Same trap walkaway-bench.mjs documents.
    """
    override = os.environ.get("CINDERPAW_BENCH_BUN")
    if override:
        return override

    # Same resolution walkaway-bench.mjs does, and for the same reasons.
    probe = shutil.which("bun") or ""
    hits = [probe] if probe else []
    if os.name == "nt":
        # `which` returns the first hit only; the .exe may be behind the shim.
        found = subprocess.run(
            ["where.exe", "bun"], capture_output=True, text=True, check=False
        )
        hits = [ln.strip() for ln in found.stdout.splitlines() if ln.strip()] or hits

    # A real executable spawns without a shell. That matters beyond tidiness:
    # routing through cmd.exe re-parses the command line, which mangles the
    # paths with spaces that this repo happens to live under.
    for h in hits:
        if h.lower().endswith(".exe"):
            return h
    # npm installs bun as a shell script plus a .cmd shim with no .exe on PATH,
    # and CreateProcess cannot exec a .cmd — which fails at spawn time and reads
    # as "the agent produced nothing". The real binary sits next to the shim.
    for h in hits:
        real = Path(h).parent / "node_modules" / "bun" / "bin" / "bun.exe"
        if real.is_file():
            return str(real)
    for candidate in (
        Path(os.environ.get("USERPROFILE", "_")) / ".bun" / "bin" / "bun.exe",
        Path(os.environ.get("HOME", "_")) / ".bun" / "bin" / "bun",
    ):
        if candidate.is_file():
            return str(candidate)
    raise AgentError(
        "could not find a bun executable to run the sidecar with. "
        "Set CINDERPAW_BENCH_BUN to its full path."
    )


@dataclass
class CinderpawAgentState:
    """
    One live sidecar per task, plus the id of the tool call it is waiting on.

    `pending_request_id` is the whole reason this is stateful: the sidecar is
    blocked inside a turn, and the answer only arrives on the orchestrator's
    NEXT call into us. Holding it here is what lets one agent turn span two
    invocations.
    """

    proc: Optional[subprocess.Popen] = None
    session_id: str = field(default_factory=lambda: f"tau2-{uuid.uuid4().hex[:8]}")
    pending_request_id: Optional[str] = None
    started: bool = False
    #: Every event the sidecar emitted, kept for post-mortem on a bad task.
    events: list[dict] = field(default_factory=list)
    #: Parsed stdout events, filled by the reader thread.
    inbox: Queue = field(default_factory=Queue)
    #: Last 40 stderr lines — the only place a boot failure is legible.
    stderr_tail: list[str] = field(default_factory=list)


class CinderpawAgent(HalfDuplexAgent[CinderpawAgentState]):
    def __init__(
        self,
        tools: list[Tool],
        domain_policy: str,
        env: Optional[dict[str, str]] = None,
        turn_timeout_s: float = 600.0,
    ):
        super().__init__(tools=tools, domain_policy=domain_policy)
        self.extra_env = env or {}
        self.turn_timeout_s = turn_timeout_s
        self._decl_path = self._write_tool_declaration(tools)

    # ---------------------------------------------------------------- setup

    def _write_tool_declaration(self, tools: list[Tool]) -> Path:
        """
        Write the domain tools in the shape CINDERPAW_HOST_TOOLS expects.

        That shape is MCP's `{name, description, inputSchema}`, which is also
        what `openai_schema` already contains — so this is a rename, not a
        translation. The full JSON Schema goes across verbatim, `$defs` and all:
        airline's `book_reservation` takes an array of Passenger objects, and an
        agent that receives only the word "array" has to invent the item shape.
        """
        decl = []
        for t in tools:
            fn = t.openai_schema["function"]
            decl.append(
                {
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "inputSchema": fn.get("parameters", {"type": "object"}),
                }
            )
        fd, path = tempfile.mkstemp(prefix="tau2-hosttools-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"tools": decl}, f)
        logger.debug(f"host tool declaration for {len(decl)} tools at {path}")
        return Path(path)

    def get_init_state(
        self, message_history: Optional[list[Message]] = None
    ) -> CinderpawAgentState:
        # Every fresh task arrives with exactly one seeded message: the canned
        # "Hi! How can I help you today?" the orchestrator puts in the agent's
        # mouth before the customer speaks (DEFAULT_FIRST_AGENT_MESSAGE,
        # orchestrator.py:47). There is nothing to replay — the sidecar has said
        # nothing and needs to know nothing — so it is skipped rather than
        # forwarded.
        #
        # A history with anything ELSE in it is a task seeded mid-conversation.
        # Nothing here replays that, and starting anyway would drop context the
        # task's grading depends on while still producing a plausible-looking
        # score. None of the 50 airline tasks use one.
        real = [
            m
            for m in (message_history or [])
            if not (isinstance(m, AssistantMessage) and not m.is_tool_call())
        ]
        if real:
            raise AgentError(
                "CinderpawAgent does not support tasks seeded with a message "
                f"history ({len(real)} message(s) beyond the opening greeting)."
            )
        return CinderpawAgentState()

    def _spawn(self, state: CinderpawAgentState) -> None:
        home = Path(tempfile.mkdtemp(prefix="tau2-cinderpaw-home-"))
        env = {
            **os.environ,
            # Nobody is at the machine to answer ask_user — the "user" here is a
            # simulator on the other side of the orchestrator, not a person we
            # can interrupt.
            "CINDERPAW_AUTONOMOUS": "true",
            "CINDERPAW_HOME": str(home),
            "CINDERPAW_HOST_TOOLS": str(self._decl_path),
            **self.extra_env,
        }
        state.proc = subprocess.Popen(
            [_resolve_bun(), str(SIDECAR_ENTRY)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(home),
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        # Both pipes are drained by threads. Two reasons, and the second is the
        # one that bites: a full pipe buffer deadlocks the child (the sidecar
        # logs plenty at boot), and a blocking read on stdout has no timeout, so
        # a wedged sidecar would hang the whole 50-task run with nothing on
        # screen. The queue turns "no answer" into a timeout we can report
        # against the one task it belongs to.
        def pump_stdout() -> None:
            assert state.proc is not None and state.proc.stdout is not None
            for line in state.proc.stdout:
                line = line.strip()
                if not line.startswith("{"):
                    continue  # sidecar log lines, not protocol
                try:
                    state.inbox.put(json.loads(line))
                except json.JSONDecodeError:
                    continue
            state.inbox.put(None)  # EOF sentinel: the sidecar is gone

        def pump_stderr() -> None:
            assert state.proc is not None and state.proc.stderr is not None
            for line in state.proc.stderr:
                state.stderr_tail.append(line.rstrip())
                del state.stderr_tail[:-40]

        threading.Thread(target=pump_stdout, daemon=True).start()
        threading.Thread(target=pump_stderr, daemon=True).start()
        state.started = True

    # ------------------------------------------------------------ transport

    def _send(self, state: CinderpawAgentState, payload: dict) -> None:
        assert state.proc is not None and state.proc.stdin is not None
        state.proc.stdin.write(json.dumps(payload) + "\n")
        state.proc.stdin.flush()

    def _read_until_actionable(self, state: CinderpawAgentState) -> dict:
        """
        Read sidecar events until one requires an answer from the orchestrator.

        Actionable means exactly two things: a `tool_request` (the model wants a
        domain tool run) or a terminal `done` (the turn produced an answer for
        the user). Everything else is the sidecar's own business — streamed
        chunks, usage, and the tool_start/tool_done of tools it runs itself,
        which correctly never reach the orchestrator.

        A `done` carrying `incomplete: true` is NOT the end of the turn: in
        autonomous mode a turn cut short by the wall clock is continued, and
        treating the first `done` as terminal would score the continuation as if
        it never happened. Same trap walkaway-bench.mjs documents. `runSummary`
        closes an unattended run and restates the last outcome; it is terminal.
        """
        while True:
            try:
                ev = state.inbox.get(timeout=self.turn_timeout_s)
            except Empty:
                raise AgentError(
                    f"the sidecar said nothing for {self.turn_timeout_s:.0f}s. "
                    "Last stderr:\n" + self._tail(state)
                ) from None
            if ev is None:
                raise AgentError(
                    "the sidecar closed its output without answering. "
                    "Last stderr:\n" + self._tail(state)
                )
            state.events.append(ev)
            kind = ev.get("type")
            if kind == "tool_request":
                return ev
            if kind == "done":
                if ev.get("incomplete"):
                    continue
                return ev
            if kind == "error":
                return ev

    @staticmethod
    def _tail(state: CinderpawAgentState) -> str:
        return "\n".join(state.stderr_tail[-15:]) or "(nothing on stderr)"

    # ------------------------------------------------------------- the turn

    def generate_next_message(
        self,
        message: UserMessage | ToolMessage | MultiToolMessage,
        state: CinderpawAgentState,
    ) -> tuple[AssistantMessage, CinderpawAgentState]:
        if not state.started:
            self._spawn(state)

        if isinstance(message, (ToolMessage, MultiToolMessage)):
            self._answer_tool_call(message, state)
        elif isinstance(message, UserMessage):
            content = message.content or ""
            if not state.events:
                # First turn carries the policy. The sidecar's system prompt is
                # its own and cannot be set over stdin, so the policy rides in
                # here, delimited — see the module header; this is a stated
                # difference from the baseline, not a hidden one.
                content = FIRST_TURN.format(
                    instruction=AGENT_INSTRUCTION,
                    policy=self.domain_policy,
                    message=content,
                )
            self._send(
                state,
                {
                    "type": "message",
                    "id": uuid.uuid4().hex,
                    "sessionId": state.session_id,
                    "content": content,
                },
            )
        else:
            raise AgentError(f"unexpected message type {type(message).__name__}")

        ev = self._read_until_actionable(state)

        if ev["type"] == "error":
            raise AgentError(f"sidecar error: {ev.get('message', '(no message)')}")

        if ev["type"] == "tool_request":
            # The orchestrator rejects a message carrying both text and tool
            # calls, so any narration the model produced alongside the call is
            # dropped here. The baseline agent lives under the same rule.
            state.pending_request_id = ev["id"]
            call = ToolCall(
                # Reusing the sidecar's request id as the tool-call id is what
                # makes the return trip trivial: the ToolMessage comes back
                # carrying it, and tau2 already asserts the two match.
                id=ev["id"],
                name=ev["tool"],
                arguments=ev.get("arguments") or {},
                requestor="assistant",
            )
            return AssistantMessage(role="assistant", content=None, tool_calls=[call]), state

        return AssistantMessage(role="assistant", content=ev.get("content") or ""), state

    def _answer_tool_call(
        self, message: ToolMessage | MultiToolMessage, state: CinderpawAgentState
    ) -> None:
        """
        Hand the orchestrator's tool results back to the suspended sidecar.

        A MultiToolMessage can only appear if we ever return more than one tool
        call in a message, which we never do — one `tool_request` in, one call
        out. It is handled anyway rather than asserted away, because the shape
        is legal and a crash here would land mid-task with the sidecar alive.
        """
        results = (
            message.tool_messages if isinstance(message, MultiToolMessage) else [message]
        )
        for tm in results:
            if tm.id != state.pending_request_id:
                # Not fatal on its own — but it means our id bookkeeping and the
                # orchestrator's have diverged, and every later result would be
                # answered against the wrong call.
                logger.warning(
                    f"tool result id {tm.id} does not match the pending "
                    f"request {state.pending_request_id}"
                )
            payload: dict = {"type": "tool_response", "requestId": tm.id}
            # `error` and `content` are distinct at the bridge: an error reaches
            # the model as a failed call it can read and retry differently.
            if tm.error:
                payload["error"] = tm.content or "tool call failed"
            else:
                payload["content"] = tm.content or ""
            self._send(state, payload)
        state.pending_request_id = None

    # ------------------------------------------------------------- teardown

    def stop(
        self,
        message: Optional[Message] = None,
        state: Optional[CinderpawAgentState] = None,
    ) -> None:
        """One sidecar per task, so it must die with the task or they pile up."""
        if state is None or state.proc is None:
            return
        try:
            self._send(state, {"type": "shutdown"})
            state.proc.wait(timeout=10)
        except Exception:
            pass
        finally:
            if state.proc.poll() is None:
                state.proc.kill()


def create_cinderpaw_agent(tools, domain_policy, **kwargs):
    """Factory for `registry.register_agent_factory(..., "cinderpaw")`."""
    return CinderpawAgent(
        tools=tools,
        domain_policy=domain_policy,
        env=kwargs.get("cinderpaw_env"),
    )
