# Checkpoint — τ²-bench integration, 2026-08-29

Written to hand this work to a new session. **Verify before trusting.** A prior
checkpoint in this repo claimed work was "NOT implemented" that had already
shipped; every claim below carries the command that re-checks it, and where a
claim is a judgement rather than a measurement it says so.

Working branch: `fix/arc-run-survives-errors` · last commit `9d65069`

---

## 0. READ FIRST — nothing is committed

Everything from this session is in the working tree only:

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
else. Three natural commits: the DSML parser fix, the perf-policy change, the
benchmark harness. The Foundever document is unrelated to this work.

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

## 2. The decisive constraint — read before writing the bridge

`src/tau2/orchestrator/orchestrator.py:895` increments `step_count` **once per
message transfer between roles** (AGENT→ENV, ENV→AGENT, AGENT→USER, USER→AGENT).
`:744` ends the run with `TerminationReason.MAX_STEPS` when it hits the cap.

Confirmed in the real transcript: the agent emitted 2 tool calls, which appear
as 4 messages and therefore 4 steps.

**Cinderpaw executes its own tools internally.** Routed through an MCP bridge,
those calls never pass through `step()` — so Cinderpaw could make 50 internal
tool calls and the orchestrator would count ~5 steps, while the 77.3 % baseline
is capped. That comparison is not defensible and must not be published.

**Therefore the bridge MUST count each Cinderpaw tool call and refuse past the
same budget, and report the count next to the score.** This is not a
nice-to-have; write it first, not after seeing a number you like.

Residual uncertainty that cannot be closed from here: **OpenRouter does not
publish its step limit.** The code has two different defaults — `orchestrator.py`
uses 100, the CLI's `--max-steps` uses 200. Either ask them, or state our
setting explicitly wherever the number is published, and describe the delta as
approximate rather than like-for-like.

---

## 3. What is NOT built

The bridge. Three pieces:

1. **MCP server** exposing the τ² domain tools, forwarding calls into the live
   τ² environment. Cinderpaw's MCP client is standard stdio; config shape is
   `{id, name, command, args, env, enabled}` in `<CINDERPAW_HOME>/mcp.json`
   (`src/egress/mcp-manager.ts:42`). The server is a separate process while the
   τ² environment lives in the parent Python process, so it needs a local socket
   back to the parent.
2. **τ² agent class.** Subclass `HalfDuplexAgent[State]`, implement
   `get_init_state(message_history)` and
   `generate_next_message(message, state) -> (AssistantMessage, State)`.
   Register with `registry.register_agent_factory(factory, "cinderpaw")`.
   Worked example: `examples/agents/minimal_text_agent.py`.
3. **Step-budget mirror** (§2).

Reusable from this session: the sidecar NDJSON protocol — send
`{type:"message", id, sessionId, content}` on stdin, read `usage` / `tool_start`
/ `tool_done` / `done` / `error` events on stdout. `scripts/polyglot-delta.mjs`
and `scripts/walkaway-bench.mjs` are the worked JS versions; ~150 lines to
restate in Python. Little else transfers — τ² does its own scoring, and the
baseline is published so there are no arms to pair.

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

1. Commit the working tree (§0).
2. Read `src/tau2/runner/batch.py` and `orchestrator.py` around `step_count` to
   pin exactly which budget the bridge must mirror.
3. Build the MCP bridge + agent class + step counter.
4. `--num-tasks 5` first. Compare shape against the stock `llm_agent` run of the
   same 5 tasks — same harness, same day, both numbers ours.
5. Only then all 50, against the published 77.3 %.

Expect Cinderpaw to be able to score **worse** than the baseline: a heavy
scaffold on a benchmark tuned for plain tool calling means more context, more
chances to violate policy, and more steps toward the cap that scores zero. That
result would still be worth having. Decide now that it gets published either
way.
