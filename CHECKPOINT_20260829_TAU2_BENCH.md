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

## 3. The bridge design — BUILT since this was written; see section 7

> **Stale heading, kept for the reasoning.** This section said "what is NOT
> built". It is built, shipped and proven (commits 0ba4ac3 and f1f1a24, with a
> paired canary in section 7). The design below is what was actually
> implemented, so it is still the right thing to read before touching it — only
> the tense is wrong.

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

## 7. Where this actually stands — 2026-08-29, end of session

**The bridge is built, proven, and the paired canary has run. Verdict: READY
for the full 50+50.** Nothing below is a plan; it is what happened, with the
command that re-checks it.

### The one command, when you are back

```bash
bash scripts/tau2/run_full_benchmark.sh
```

Both arms sequentially, then the matrix. ~$1.50 and ~4.7h (Cinderpaw ~3.1h,
baseline ~1.6h). Nothing else needs deciding first.

### Paired canary, five WRITE-HEAVY tasks (7, 8, 11, 12, 14)

Not tasks 0-4: **none of the first five mutate anything**, so the default
`--num-tasks 5` would have passed green without a single write ever crossing
the replay — the exact path this session existed to fix.

```
 task  rew    db  comm  msgs  calls  wr    sec   |  llm_agent
    7  0.0  True   0.0    32     12   3    166   |  0.0  True  comm 0.0
    8  1.0  True   1.0    40     11   4    341   |  1.0
   11  0.0 False   1.0    20      6   0    153   |  1.0  True
   12  1.0  True   1.0    30      6   2    196   |  1.0
   14  1.0  True   1.0    28      8   2    250   |  1.0

  cinderpaw  solved 3/5  db 4/5  MAX_STEPS 0  infra 0  |  8.6 calls (2.2 wr)  221 s/task
  llm_agent  solved 4/5  db 5/5  MAX_STEPS 0  infra 0  |  7.8 calls (1.6 wr)  113 s/task
```

Both arms ran on OUR harness the same day. The only variable is the agent —
`llm_agent` is tau2's reference agent (14 domain tools, nothing else) and is a
thermometer, not a product; it cannot run outside the airline domain.

**Task 7 fails IDENTICALLY in both arms** (db True, communicate 0.0). That is
not a Cinderpaw defect. The only Cinderpaw-specific failure is task 11, where
it communicated correctly and never acted — 0 writes where the baseline made 1.

### The gate, criterion by criterion

| # | Criterion | Status |
|---|---|---|
| 1 | Zero infrastructural failures | PASS — both arms, 0 infra, 0 MAX_STEPS |
| 2 | Writes survive the replay | PASS — 11 writes over 4 tasks, db_match 4/5 |
| 3 | No systematic same-cause failure | PASS — task 7 fails in both arms; one Cinderpaw-only failure |
| 4 | Cost and time predictable | PASS — $0.0203/task, 221s mean, slowest 1.5x mean |
| 5 | Baseline runs clean | PASS — 0 infra, 0 MAX_STEPS |

A one-task delta at n=5 is 20 points: noise, not a result.

### Measured cost (do not re-estimate this)

| | agent | user sim | per 50 |
|---|---|---|---|
| cinderpaw | $1.01 (252k prompt tok/task, from the event stream) | $0.12 | **$1.13** |
| llm_agent | ~$0.25 (estimated) | $0.12 | **$0.37** |

`agent_cost` reads **$0.0000** for the llm_agent arm — litellm returns no cost
for `openrouter/z-ai/glm-5.3-flash`. That is untracked, NOT free; the
$0.005/task figure comes from OpenRouter's published board and matches a prompt
roughly a third the size of ours.

### Why both arms, and when we can stop paying for the baseline

Citing our Cinderpaw number against OpenRouter's published 77.3% would
attribute every harness difference to the runtime — and we know of three: the
user simulator routes through OpenRouter rather than Google directly, their
`--max-steps` is unpublished (we use 200, the orchestrator default is 100), and
their tau2 version and concurrency are unknown.

The baseline arm is therefore a ONE-TIME harness validation, not a permanent
tax. If the 50-task baseline lands near 77.3%, our harness reproduces theirs
and later rounds can cite the published number and run Cinderpaw alone. Early
signal is good but proves nothing: our llm_agent canary was 4/5 = 80% against a
published 77.3%, at n=5.

### What to watch at n=50 — flagged, deliberately NOT fixed

- **Task 11's failure mode**: communicated, never acted. The only
  Cinderpaw-only failure in the canary.
- **Cinderpaw writes more**: 2.2 vs 1.6 mutations per task; on task 8, four
  against one, both scoring db_match True. Redundant mutations that still land
  on the correct state. n=50 says whether that is noise or a pattern.
- **Cinderpaw is ~2x slower** (221s vs 113s). That is the scaffold's cost.

### An honest expectation about the number

The hope is >80%. Note what that requires: the reference agent scored 4/5 on
the canary and the published GLM figure is 77.3%, so clearing 80% means beating
a plain agent at plain tool calling — on a benchmark calibrated for exactly
that, while carrying 10.8k tokens of prefix against its ~4.8k.

The original warning stands, and was written before any number existed:
Cinderpaw scoring WORSE is a live possibility. It is already decided that the
result gets published either way. A scaffold built for long, tool-using,
memory-carrying work that loses on short scripted tool calls is a precise and
publishable claim about where it helps — more useful than another leaderboard
percent.

---

## 8. What shipped this session

Thirteen commits, `9d65069..5c84090`. Full suite green at each: 3,633 pass,
0 fail, plus 15 cargo and 20 vitest.

The bridge, and four bugs found by chasing the sidecar event stream rather than
guessing. **None of them was the model reasoning too much**, which was the
standing suspicion the whole time:

| Commit | What it was |
|---|---|
| `0ba4ac3` | host tools: the sidecar suspends a call and lets the host run it |
| `f1f1a24` | the tau2 agent + runner; tool calls round-trip through the orchestrator |
| `1451cf4` | sections 2/3 corrected: the graded DB is a REPLAY of the trajectory |
| `a2e31cf` | host tools flip tool tiering — 16,488 to 10,830 tokens of prefix |
| `67cee1b` | a customer must never be told to "try a larger model" |
| `21b780a`, `f717085` | a host tool cannot be awaited inside a notebook cell |
| `b50b2b8` | load_tool: "already available" is not "no such tool" |

`scripts/tau2/` holds the agent, the runner, `compare_arms.py` (shape first,
reward last) and `run_full_benchmark.sh`. Sidecar events land in
`CINDERPAW_TAU2_EVENT_DIR` — tau2's own results.json records the CONVERSATION,
which is exactly the half that is empty when the failure is inside the agent.

### What is NOT being tested, and must be said next to any number

Each task gets a fresh `CINDERPAW_HOME`, so the profile is empty: **no MCP
extensions, no skills, no soul, no cross-task memory, no settings**. Brain is
`brain.json.disabled` even in the real profile. Active and proven in the run:
the agent loop, tool registry, the drawer, working and fractal memory within a
task, model routing, safety points, unattended continuations.

Two deliberate changes for host mode: built-ins move behind the drawer
(reachable via `list_tools`/`load_tool`), and the notebook cannot call domain
tools. The second is a real loss — the notebook is the largest measured token
lever and it is unavailable for exactly the tools that matter here.

So the honest phrasing is **"Cinderpaw's agent loop"**, not "Cinderpaw".

### Unrelated, still uncommitted, NOT mine

Voice work by another agent sits uncommitted in this same working tree:
`livekit.rs`, `livekit_agent.mjs`, `CallOverlay.tsx`, `VoiceEngineCard.tsx`,
`tauri/index.ts`, `commands/livekit.rs`, `lib.rs`. There is no
`fix/voice-badges-and-livekit-snappy` branch anywhere — local, bloom500 or
origin. **We are sharing a worktree**; a `git add -A` here can swallow that
work. Verified hunk by hunk that this session's commits did not.

Static verification of it passed: frontend `tsc` clean, `VoiceEngineCard` 3/3,
`cargo test -p cinderpaw-core livekit` 9/9,
`the_catalog_goes_over_the_wire_in_camel_case` ok, `cargo check` clean. The
manual steps (badges on screen, TTFM, partial transcript latency) were NOT done
and are not claimed.
