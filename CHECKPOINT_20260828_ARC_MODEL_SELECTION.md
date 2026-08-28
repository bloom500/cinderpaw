# Checkpoint — ARC-AGI-3, 28 Aug 2026: the preflight, four bugs, and the model hunt

Branch `fix/arc-run-survives-errors`. Head `1729d77`. Working tree clean.

**Read this before touching anything.** The session started as a production-
readiness audit before the first paid run and ended with the model disqualified,
two measurement-integrity bugs fixed, and a concrete plan that has not been
executed. Total spent: **~$0.10 of the OpenRouter budget. ~$6.85 remains** (the
user's figure, which is authoritative — my arithmetic drifted from it).

---

## 1. Where things stand in one paragraph

The ARC-3 harness is sound and heavily verified. The *model* was the problem:
GLM 5.3 Flash cannot choose an x,y coordinate without burning 15,000–65,536
completion tokens and 6–12 minutes, at both `medium` and `low` reasoning effort.
A five-model shootout found **`meta/muse-spark-1.2-contributor`** answering the
same question in ~2,000 tokens and ~15 seconds. A Muse canary is running (or has
just finished) and shows no explosions and zero fallbacks, but a **monotonic
climb in reasoning tokens** whose cause has been diagnosed and NOT yet fixed.
The next actions are: fix the token climb, then wire the agentic primitives
(coworker supervisor, FMS, BRSI substrate, MCTS/DSL) into the ARC harness.

---

## 2. Commits this session, in order

| commit | what |
|---|---|
| `bd45bd9` | Sticky-WIN forfeit + attempt accounting + forensic trace + GLM default + `--no-frugal` + manifest seed/budgets + `games.txt` tracked + the free end-to-end harness |
| `0a601ec` | The control arm is NOT a bare model — renamed and documented; card-lifetime probe |
| `7154622` | There is no practice card; the dirty-tree gate applies to every card |
| `9e72ed8` | Click candidate generation (shortlist, not answer) + `--no-click-candidates` |
| `6ec9170` | **A press must be a decision** (answerRegion) + one colour spelling (colour.ts) |
| `1729d77` | Probe: `--any-provider`, `--max-tokens`, parsed-vs-fallback reporting |

---

## 3. The four bugs, worst first

### 3.1 The harness invented presses (measurement contamination)

A press cost **65,536 completion tokens** — exactly 2^16, GLM's output ceiling,
hit and truncated. The reply ended mid-sentence inside its own reasoning:

```
...Wait colors list says 10x1805, 3x178, 14x147, 0x62, 9x6, 11x2, 15x2</think>
```

No answer. But `parseChoice` scanned the WHOLE reply for the last mention of an
offered action, found one in the model's own notes ("ACTION3/4/6/7 correspond to
operations like fill, erase"), pressed ACTION3, and recorded `source: "model"`.
`onUnparsed` never fired.

**Fixed** in `6ec9170`. `answerRegion()` returns what follows the last
`</think>`, or null when the thinking never closed (truncation) or nothing
follows it. `parseChoice` reads only that.

**Proven live, not asserted:** reintroducing the old behaviour makes the
100-game stress report **68 false decisions out of ~400 presses** and fail. With
the fix, 761 undecidable replies → 761 unparsed → 0 false decisions.

`false_decisions` is now a release gate in the stress summary. It fired again in
production on canary2b press 4 (65,536 tokens, correctly labelled
`unparsed-fallback`).

### 3.2 Two spellings for one colour

The model, mid-monologue: *"color 10 is 'a' in hex? ... But colors list uses
decimal?"* It was right. `renderGrid` wrote hex; the scene summary and click
candidates wrote decimal. It spent a fortune deriving the mapping and ran out of
room before answering.

**Fixed.** `src/arc/colour.ts` is the single renderer; `formatSceneGraphYaml`
takes the formatter (`colour: ColourFormatter = String`, so no other caller
changes). A test walks all 16 colours through grid, scene and candidates. The
system prompt also states the encoding out loud.

### 3.3 Sticky WIN forfeited every level after the first

If the server keeps reporting `WIN` after a level clears, `playLevel` returns on
its terminal check before pressing anything, and the old zero-action guard broke
the loop — a 3-level game stopped at 1. Now it spends a free `RESET` (a LEVEL
reset in competition mode) and continues. Bounded: the nudge requires the level
counter to have moved. Reproduced and verified `levels 1/3 → 3/3`.

### 3.4 `attempts[].actions` reported 0 for an attempt that spent 24 presses

It recorded only the last pass of the multi-level loop.

---

## 4. What was verified, and how

- **100-game stress** (`scripts/arc/stress_100.mjs`): 100/100, **0 violations**,
  0 false decisions, 22–23 retry cycles, 0 unhandled exceptions, 0 resource
  leaks. The fake server is an *auditor* — it refuses stale actions, actions
  after terminal, bare ACTION6, unknown guids, wrong cookies, and cross-checks
  its own per-game action tally against the client's.
- **Determinism**: three 20-game runs at one seed → byte-identical output.
- **No module-level mutable state anywhere in `src/arc/`.** State leakage is
  structurally impossible, not merely unobserved.
- **Model calls == actions, exactly 1:1 over 5,080 actions.** This is the
  property that makes the trace credible and it must survive the agentic work.
- **Card lifetime: 60.0 minutes, 6/6 presses, clean close** (`GREEN`). Probe:
  `scripts/arc/card_lifetime_probe.mjs`.
- **Every card is a competition card** — the server ignores
  `competition_mode: false`. Measured three ways.
- 147 tests pass (`tests/arc-*.test.ts`, `tests/scene-graph.test.ts`).

### The free end-to-end harness (the most reusable thing built today)

`--dry-run` was never free: it skips the MODEL, not the SERVER, and still opens
a real scorecard and spends real actions. So:

- `scripts/arc/fake-arc-api.mjs` — the auditing fake server
- `scripts/arc/fake-arc-preload.mjs` — swaps the global `fetch`; with
  `FAKE_ARC_MODEL=1` it fakes OpenRouter too, at real GLM prices

```bash
ARC_API_KEY=fake OPENROUTER_API_KEY=fake FAKE_ARC_MODEL=1 \
  bun --preload ./scripts/arc/fake-arc-preload.mjs \
  scripts/arc/run_arc_agi3.mjs --game game-5 --retries 2
```

**Bugs 3.3 and 3.4 were found this way, in minutes, for $0.00.** Use it before
every paid run.

---

## 5. The model hunt

### GLM 5.3 Flash is disqualified

| run | press | completion tokens | latency |
|---|---|---|---|
| canary #1, effort medium | 4 | 27,163 | 623s |
| canary #1, effort medium | 8 | 31,137 | 718s |
| probe, effort **low** | 4 | **31,557** | 642s |
| canary #2b, medium + candidates | 3 | 15,055 | 389s |
| canary #2b, medium + candidates | 4 | **65,536 (ceiling)** | 762s |

Named buttons cost it 14–45 tokens. Coordinates cost it thousands. **`low` was
worse than `medium`** — the effort knob is not the lever, despite a code comment
claiming Z.AI honours it.

### Shootout — one call each, same recorded frame, `--max-tokens 8000`

| model | completion | latency | $/press | verdict |
|---|---|---|---|---|
| **`meta/muse-spark-1.2-contributor`** | 1,638 / 2,631 | 12s / 20s | **$0.00074** | real answer |
| `google/gemini-3.7-flash` | 1,448 / 847 | 16s / 8s | $0.0039 | real answer, 5× the price |
| `z-ai/glm-5.3-flash` | **hit 8k cap** | 137s | — | no answer |
| `deepseek/deepseek-v4-flash-0731` | **hit 8k cap** | 84s | — | no answer |
| `qwen/qwen3.8-flash` | — | — | — | **429 twice, never measured** |

Muse: single upstream, **Meta**, first-party — no routing variance to control
for. Pricing $0.10/M in, $0.20/M out.

**Read the fallback column, always.** `ACTION3` is `offered[0]`, so a model that
answers nothing produces a press that looks identical to a genuine choice of the
first action. That is why `1729d77` exists.

### Muse canary (running / just finished) — `runs/arc-1787915562123/`

At 22 presses: **0 fallbacks** (every press a real decision), no explosions,
`levels 0/9`, median 6,205 tokens, max 11,248, median 72s, **$0.00158/press**,
27.6 min. Card `--max-spend 0.05`.

**The unresolved problem: reasoning tokens climb monotonically.** 1,305 → 2,367
→ 2,903 → … → 11,248.

---

## 6. THE NEXT FIX, fully diagnosed and NOT implemented

**Prompt tokens are FLAT** — 3,088 to 3,143 across every press. The growth is
entirely in the completion. The grid changes every press, so the agent is not
stuck.

At press 1 the model reasons: *"Testing the undo action to observe state changes
and infer other action effects."*
At press 11, 9,388 tokens: *"Evaluating whether to select a target region before
applying the palette action... maximize information gain from the next action."*

**It is still deducing what the buttons do.** It rebuilds the causal model from
scratch every turn, because the prompt tells it what it pressed and never what
happened:

```
Your last presses: ACTION6:21,39, ACTION6:21,3, ACTION6:27,3, ...
```

Eight scattered clicks with no outcomes look identical to eight clicks that did
nothing, and it pays again each turn to find out.

Meanwhile `createFrugalPolicy` has been recording exactly this and discarding it,
using it only to filter the offered list:

```ts
transitions  // `${gridKey}|${action}` -> resulting gridKey
perAction    // { inertIn: Set<state>, everMoved: boolean }
```

**The fix: tell the model what its recent presses DID.** `ACTION4 → the grid
changed`, `ACTION6:21,3 → nothing changed`. Tens of prompt tokens, and it
removes the question the model keeps re-asking.

Design: an OPTIONAL field on `PolicyContext` (e.g. `outcomes`), populated by the
frugal policy, read by the model policy. Optional keeps every other caller and
the whole app/CLI untouched. This is a general improvement — an agent knowing the
result of its own actions is not an ARC hack.

**Measure it against the Muse canary as the control.** Same game, same cap.

---

## 7. Architecture finding: primitives are separable, the assembly is not

The user asked whether wiring BRSI/FMS/coworkers into ARC would damage the app.
Investigated:

| component | wirable into the bench without `boot()`? | evidence |
|---|---|---|
| Coworker supervisor | **YES** | `CoworkWorkerDeps` = mailbox, handoffs, 2 callbacks |
| FMS skill induction | **YES** | imports only `fs`, `path`, `compileProgram`, `cinderpawHome` |
| FMS fractal memory | **YES, structurally** | `EmbedInvoker` is an INJECTED type; `embed.ts` has no fetch/llama/localhost |
| BRSI substrate | **YES** | `bootstrapOnce(db.raw)` — one call, already fail-soft |
| BRSI dream cycle | **design decision** | triggers are idle/error/schedule. During continuous play the agent is never idle |
| BRSI Rust slice | **NO** | git repo, PLAN.md, SandboxBounds, audit chain — bootstrapped by Tauri `setup()` before the sidecar spawns |
| `boot()` headless | technically | `Transport` is 4 methods; but **nothing in the repo has ever booted headless** |

**The decisive finding:**

```ts
// src/boot.ts:2428
export type BootContext = Awaited<ReturnType<typeof boot>>;
```

`BootContext` is not a designed interface — it is whatever a 2,429-line function
happens to return. **There is no composition root and no "core" layer.** The
primitives are general; the assembly is chat-shaped.

`DreamTrigger` already carries two RESERVED members with the documented pattern
*"type-first, emitter-later"*, so adding `environment_boundary` follows the
codebase's own convention rather than hacking it.

**Recommendation: do NOT boot the agent. Wire the primitives directly.** Not out
of caution — out of accounting. The 1:1 call/action property exists because every
call passes through `complete.usage()`. `boot()` brings transport, cron, tools and
connectors that ARC does not need and buries model calls where that counter
cannot see them. The user's own rule — *"if the system spends $0.40 we want to see
exactly where the $0.40 went"* — argues for piece-by-piece wiring.

**Discipline for shared code:** any change to shared code must have a default
that preserves existing behaviour. Done today with
`formatSceneGraphYaml(g, colour = String)`. If an integration cannot be done that
way, that is the signal it has become `if (ARC)` and must stop.

---

## 8. Economics, with real numbers

Per press, measured: GLM $0.0053 · Muse $0.00158 (climbing) · Gemini $0.0039.
AVO reference: 6,624 actions over 25 games ≈ 265 actions/game.

| model | $/benchmark | wall clock (25 in parallel) |
|---|---|---|
| Muse (current, climbing) | ~$10 | ~4.6 h |
| Muse (if the token fix lands) | ~$5 | ~1.5 h |
| Gemini 3.7 | ~$26 | ~0.9 h |
| GLM 5.3 | ~$35 | ~21 h |

**Card lifetime is proven to 60 minutes.** A 4.6-hour benchmark exceeds the
evidence; a 1.5-hour one is closer. This is why the token fix gates everything.

Two benchmarks (CONTROL + CINDERPAW) back to back need the fix to land.

---

## 9. The plan, in order

1. **Let the Muse canary finish** — it is the control for the token fix.
2. **Implement outcome feedback** (§6). Free verification: 147 tests + 100-game
   stress + `false_decisions == 0`.
3. **Re-run the Muse canary** with outcomes. Measure the delta.
4. **Wire the agentic primitives**: coworker supervisor (one worker, no
   subagents) → MCTS/DSL (one line, already written and tested) → FMS →
   BRSI substrate + an `environment_boundary` dream trigger between levels.
   Every call through `complete.usage()`. Zero accounting magic.
5. **One C run, one game.** Then the two full benchmarks.

Report A / B / C separately: A = model + interface, B = + ARC systems,
C = + agentic runtime. If B beats C, that is the most valuable result of all.

---

## 10. Operational rules learned the hard way

- **Never `kill -9` the runner.** `TaskStop` SIGKILLs; the SIGINT/SIGTERM
  handlers never run and the card is orphaned. Two cards were lost this way
  (`2178eb4f`, `c8b26a12`). They auto-finalise as abandoned.
- **A card cannot be closed from a fresh cookie jar** — `404 scorecard not
  found`. Backend affinity is real; the cookie must travel with the id.
- **Commit before opening any card.** Every card is a competition card and the
  gate now refuses a dirty tree on all of them.
- **`--dry-run` is not free.** Use the fake-server preload.
- Long jobs go in the background with a monitor; do not block the session.

---

## 11. Files added this session

```
CinderpawAgent/src/arc/colour.ts                      single colour renderer
CinderpawAgent/scripts/arc/stress_100.mjs             100-game auditor + false_decisions
CinderpawAgent/scripts/arc/fake-arc-api.mjs           the auditing fake server
CinderpawAgent/scripts/arc/fake-arc-preload.mjs       free end-to-end runner
CinderpawAgent/scripts/arc/card_lifetime_probe.mjs    60-minute card probe
CinderpawAgent/scripts/arc/probe_click_candidates.mjs one-call model shootout
CinderpawAgent/tests/arc-answer-region.test.ts        19 tests, the release gate
runs-arc/games.txt                                    the 25 game ids, now tracked
```

Run data: `CinderpawAgent/runs/arc-1787904398715` (GLM medium),
`arc-1787906438353` (GLM low), `arc-1787913543659` (GLM + candidates),
`arc-1787915562123` (**Muse — the control for the next fix**).

---

## 12. What is NOT proven — no sugarcoating

- **Muse has never cleared a level.** `levels 0/9` at 22 presses. Cheap and
  ineffective is still ineffective. Cost was measured; capability was not.
- The 17.7× candidate-generation figure came from a single-frame diagnostic
  probe taken while the harness still had the false-decision bug. **It is not a
  benchmark result** and must not be quoted as one.
- Candidate generation did NOT stop the explosion in a real game (canary2b press
  3: 15,055 tokens with candidates ON).
- Qwen3.8 Flash was never measured — 429 twice.
- Muse variance is large: 1,638 then 2,631 tokens on identical input at
  temperature 0.
- The sticky-WIN branch has never run against the real server. It is dead code
  under the benign reading of `WIN` and saves the run under the hostile one, but
  its first real exercise will be during a paid run.
- Spend is computed from OpenRouter list price and has never been reconciled
  against an invoice.
