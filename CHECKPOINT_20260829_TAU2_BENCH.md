# Checkpoint — τ²-bench integration, 2026-08-29

Written to hand this work to a new session. **Verify before trusting.** A prior
checkpoint in this repo claimed work was "NOT implemented" that had already
shipped; every claim below carries the command that re-checks it, and where a
claim is a judgement rather than a measurement it says so.

Working branch: `fix/arc-run-survives-errors` · last commit `9d65069`

---

## 0. The working tree — COMMITTED 2026-08-29

Three commits on `fix/arc-run-survives-errors`, tests green before each
(25 bun, 20 vitest, 15 cargo):

- `9ae0eb5` DSML tool-call parsing (`agent-loop.ts` + new test)
- `73e733f` perf policy across TS/Rust/React
- `762d5d0` bench harness, `vendor/` ignored, this checkpoint

Left deliberately untracked: `scripts/build-foundever-doc.py` and
`Darius-Bloom-Foundever-Supporting-Document.docx` — a job-application document,
unrelated to this work.

<details><summary>Original warning, for the record</summary>

Everything from this session was in the working tree only:

```
 M .gitignore                                    (adds vendor/)
 M CinderpawAgent/src/core/agent-loop.ts         (DSML tool-call parsing)
 M CinderpawAgent/src/egress/inference-providers.ts  (TTFT scaling wired up)
 M CinderpawAgent/src/egress/perf-policy.ts      (cloud deadlines raised)
 M CinderpawAgent/tests/perf-policy.test.ts      (invariant inverted)
 M crates/cinderpaw-core/src/perf_policy.rs      (same, Rust layer)
 M frontend-react/src/lib/perfPolicy.ts          (same, React layer)
 M frontend-react/src/lib/__tests__/perfPolicy.test.ts
 M scripts/walkaway-bench.mjs                    (made importable)
?? CinderpawAgent/tests/dsml-tool-call.test.ts
?? scripts/polyglot-delta.mjs
?? scripts/build-foundever-doc.py                (unrelated: job-application doc)
?? Darius-Bloom-Foundever-Supporting-Document.docx  (unrelated)
```

`git stash` or a careless `git checkout` loses all of it. Commit before anything
else.

</details>

---

## 1. What is done and verified

### τ²-bench runs end to end on this machine

```bash
cd "D:/Cinderpaw Agent/vendor/tau2-bench"
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 uv run tau2 run \
  --domain airline --agent-llm openrouter/z-ai/glm-5.3-flash \
  --user-llm gemini/gemini-2.5-flash --num-trials 1 --num-tasks 1 --max-concurrency 1
```

Result on 2026-08-29: **reward 1.0**, DB match, `user_stop`, 46.5 s, 14 messages.
Saved under `data/simulations/20260829_133752_airline_.../results.json`.

Three Windows gotchas already paid for — do not rediscover them:

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: audioop` | removed from stdlib in 3.13; tau2 imports it via the voice path unconditionally | pin Python **3.12** (`.python-version`, `uv sync --python 3.12`) |
| `UnicodeEncodeError: charmap ... \u2192` | `rich` printing to a cp1252 console | `PYTHONIOENCODING=utf-8 PYTHONUTF8=1` |
| no model reachable | tau2 reads `.env`, not the OS keychain | `.env` is written from Credential Manager — see §4 |

`vendor/` is gitignored: the clone carries its own git history and a `.env` with
live keys.

### Airline domain

50 tasks (`data/tau2/domains/airline/tasks.json`). OpenRouter's published board
requires ≥45 graded tasks per model-provider pair, so a full run is all 50.

### The published baseline we are measuring against

<https://openrouter.ai/benchmarks/tau2-bench-airline>, last run 2026-08-29:

- **GLM 5.3 Flash: 77.3 %**, $0.005/task, rank #17, marked Pareto-optimal
- Claude Fable 5 leads at 81.5 %
- user simulator pinned to `gemini-2.5-flash`
- scoring `reward = db_match × communicate_met`, both binary
- runs over the max step limit score **zero**

This is the reason τ² was chosen over Aider Polyglot: it is the only benchmark
found with a **current, published number for our exact model**, so the control
arm does not have to be run by us — and cannot be accused of being sandbagged.

---

## 2. The decisive constraint — CORRECTED 2026-08-29, later the same day

**The design in the previous revision of this section and of §3 was wrong and
would have produced a run scoring at most 7/50.** Kept here in full, because the
reasoning that produced it is plausible and someone will re-derive it.

### What is actually graded

`src/tau2/evaluator/evaluator_env.py:86` does NOT hash the live environment the
agent worked in. It builds a **fresh** environment and calls

```python
predicted_environment.set_state(..., message_history=list(full_trajectory))
```

and `src/tau2/environment/environment.py:319-350` walks that trajectory,
pulls out every `AssistantMessage.tool_calls` with its matching `ToolMessage`,
and **replays them** into the fresh environment. The DB that gets hashed is the
replay, not the live object.

> A tool call that is not in the orchestrator's trajectory does not exist at
> grading time.

All 50 airline tasks have `reward_basis = ('COMMUNICATE', 'DB')` — no ACTION
component — so nothing else would have caught it. 43 of the 50 carry expected
write actions. Verify both:

```bash
cd vendor/tau2-bench && python -c "import json,collections; t=json.load(open('data/tau2/domains/airline/tasks.json')); print(collections.Counter(tuple(sorted((x.get('evaluation_criteria') or {}).get('reward_basis') or [])) for x in t)); print(sum(1 for x in t if (x.get('evaluation_criteria') or {}).get('actions')))"
```

**The trap is that it fails quietly.** The 7 read-only tasks would still pass, so
the bridge would look wired up and merely weak, not broken.

### What this does to the step budget

The previous revision worried that Cinderpaw executing tools internally would
let it make 50 tool calls while the orchestrator counted ~5 steps, making the
comparison against a capped baseline indefensible, and demanded a mirrored step
budget written before any number was seen.

That problem is now moot — and it was the same bug wearing a different hat.
Because every graded tool call must pass through the orchestrator anyway,
`step_count` counts Cinderpaw's calls **natively and identically to the
baseline**. Confirmed at `orchestrator.py:895` (`step_count += 1` per message
transfer) and `:744` (`>= max_steps` → `TerminationReason.MAX_STEPS`, checked
only when `to_role != ENV`, so one agent tool call costs 2 steps and is checked
on the return leg).

No mirrored budget, no self-imposed refusal, no separate call count to publish.
The honest comparison falls out of doing the thing correctly.

Still open, unchanged: **OpenRouter does not publish its step limit.** The code
carries two defaults — `orchestrator.py` 100, the CLI's `--max-steps` 200. Ask
them, or state our setting wherever the number is published and call the delta
approximate rather than like-for-like.

---

## 3. What is NOT built — the bridge, redesigned

The requirement from §2 is now precise: **Cinderpaw must emit its domain tool
calls to the orchestrator and receive the results back, rather than executing
them.** The sidecar has no such mode — `src/dispatch.ts` has no host-provided
tool passthrough, and its MCP client (`src/egress/mcp-client.ts:180`) is stdio
only, spawning its own child; there is no HTTP/SSE transport to point at the
parent.

But MCP over stdio IS an "emit a call, block for a result" protocol. So the
tool calls round-trip through the orchestrator like this:

```
sidecar model calls mcp_book_reservation
  -> MCP client -> stdio -> forwarder script -> socket -> agent process
       agent process is blocked inside generate_next_message; it now RETURNS
       AssistantMessage(tool_calls=[...]) to the orchestrator
  -> orchestrator executes it in the live env, appends call+result to the
     trajectory, step_count += 2
  -> orchestrator calls generate_next_message(ToolMessage)
  -> agent sends the result back down the socket -> forwarder -> MCP -> sidecar
     resumes the same turn
```

Eventually the sidecar emits final text; the agent returns
`AssistantMessage(content=...)` and the orchestrator hands it to the user
simulator. The trajectory is real, so the replay grades correctly.

The critical inversion versus the previous revision: **the forwarder must
forward into the ORCHESTRATOR, not into the live environment.** Calling
`tool(**args)` in the parent mutates the live DB — which is never graded — and
writes nothing to the trajectory, which is.

Three pieces:

1. **Forwarder** — a small stdio MCP server exposing the τ² domain tools,
   spawned by Cinderpaw via `<CINDERPAW_HOME>/mcp.json`
   (`{id, name, command, args, env, enabled}`, `src/egress/mcp-manager.ts:42`).
   Every `tools/call` blocks on a loopback socket to the agent process.
2. **Socket server in the agent process** — one JSON line per request. It must
   hold a pending call across `generate_next_message` boundaries, since the
   answer only arrives on the orchestrator's next invocation.
3. **τ² agent class** — subclass `HalfDuplexAgent[State]`, implement
   `get_init_state(message_history)` and
   `generate_next_message(message, state) -> (AssistantMessage, State)`;
   register with `registry.register_agent_factory(factory, "cinderpaw")`.
   Worked example: `examples/agents/minimal_text_agent.py`. It owns one sidecar
   process per task and keeps one `sessionId` for the whole conversation —
   multi-turn on a session is supported (`src/dispatch.ts:1245`).

Reusable: the sidecar NDJSON protocol — write
`{type:"message", id, sessionId, content}` to stdin, read `usage` / `tool_start`
/ `tool_done` / `done` / `error` from stdout. `scripts/walkaway-bench.mjs`
(see `runTask`) and `scripts/polyglot-delta.mjs` are the worked JS versions;
~150 lines to restate in Python. Note `done` with `incomplete: true` is NOT the
end of a turn.

---

## 4. Keys

Both live in Windows Credential Manager, written as UTF-16LE generic
credentials, same store the app uses for BYOK:

```
openrouter.ai.bloom.cinderpaw.byok    73 chars
gemini.ai.bloom.cinderpaw.byok        53 chars
nvidia.ai.bloom.cinderpaw.byok
```

`vendor/tau2-bench/.env` was generated from them and holds
`OPENROUTER_API_KEY` + `GEMINI_API_KEY`. Regenerate with the scratchpad script
`write-tau2-env.ps1` (session-local — rewrite it if the scratchpad is gone; it is
~40 lines of `CredReadW` P/Invoke).

**The Gemini key was pasted into a chat transcript in plaintext on 2026-08-29
and should be rotated.**

---

## 5. Measured costs — budget is not the constraint

`z-ai/glm-5.3-flash` on OpenRouter: **$0.075/M prompt, $0.250/M completion**.

From the Polyglot runs (real, not estimated): **$0.0066 per task**, of which
~98 % is prompt tokens — 496 k prompt vs 9.6 k completion over 6 runs. The whole
day of benchmarking cost under $0.15.

At that rate a full 50-task airline run is roughly **$0.30–1.00**. With ~$13
available, the limit is integration time, not money. Do not let a cost argument
drive a decision here; it is the wrong axis.

---

## 6. Findings from today that shape the τ² work

- **Cross-task memory does not engage.** After 3 tasks sharing one profile,
  `semantic` = 0 rows and `recall` was never called. Structural sharing works;
  nothing writes durable facts and nothing reads them unless the model chooses
  to call `recall`. See the memory note `memory-does-not-engage-across-tasks`.
  Consequence for τ²: **this is fine there** — τ² conversations are multi-turn
  *within* one task, where working memory does function. Do not expect the
  cross-session path to contribute, and do not claim it does.
- **A malformed tool call costs a full round trip** (~20 k prompt tokens). The
  largest source of cost variance observed. On the same exercise the tool-call
  count swung between 3 and 8 purely on whether the model got the format right.
- **Variance between runs exceeds any arm difference** at n=5. Report medians
  with the spread, never a bare percentage.

---

## 7. Suggested order for the next session

1. ~~Commit the working tree (§0).~~ Done — `9ae0eb5` (DSML parser),
   `73e733f` (perf policy), `762d5d0` (bench harness + this file).
2. ~~Pin the step budget.~~ Done, and it changed the design — read §2 and §3
   before writing a line of the bridge. The short version: what gets graded is
   a REPLAY of the orchestrator's trajectory, so tools must round-trip through
   the orchestrator, and the step budget then takes care of itself.
3. Build the forwarder + socket + agent class (§3). No step counter needed.
4. `--num-tasks 5` first. Compare shape against the stock `llm_agent` run of the
   same 5 tasks — same harness, same day, both numbers ours.
5. Only then all 50, against the published 77.3 %.

Expect Cinderpaw to be able to score **worse** than the baseline: a heavy
scaffold on a benchmark tuned for plain tool calling means more context, more
chances to violate policy, and more steps toward the cap that scores zero. That
result would still be worth having. Decide now that it gets published either
way.
