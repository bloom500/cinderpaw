# Checkpoint 2026-09-26: BRSI + FMS audited as one circuit

An adversarial pass over BRSI (the evolution engine) and FMS (Fractal Memory
Search) as ONE loop: Observation → Memory/FMS → Evidence → BRSI candidate →
Eval → Champion/Reject → Runtime → Outcome → Memory. Reconstructed from code
only. **Current code wins over this file**: check a claim against the code
before building on it.

- Branch: `claude/vigilant-knuth-jqrbqc` (the pre-release PR bloom500/cinderpaw#21)
- Fixes: 12 `fix(...)` commits, each with its own regression test, and 5 `docs(...)` commits.
- `./scripts/verify.sh`: green on Linux — agent 4336/4336, React 1009/1009,
  both typechecks, sidecar build, `cargo check`, Rust host 180/180, core
  501/501, TUI tests + build.

## The loop as it actually runs

| Edge | Live? | Where |
|---|---|---|
| Turn → episodic rows (FTS5, later FMS leaves) | yes | `agent-loop.ts`, `episodic.ts` |
| Extracted fact → SemanticMemory → reactive leaf (grafted) | yes, until the next rebuild/restart | `reconciler.ts`, `fractal-memory.ts#upsertLeaf` |
| Memory → every turn: tree hits + known facts + graph | yes (facts were DROPPED once a tree existed — fixed) | `fractal-memory.ts#recall`, `recall.ts#knownFacts` |
| Tree follows the corpus | yes (it froze after the first build — fixed) | `rebuildIfStale`, boot only |
| FMS → L1 evidence for promotion | **no** | eval = Tier 0 (Rust) + embedded Tier 1/2, never recall |
| Real outcomes (tools, thumbs, task results) → L1 | journal only (`userSatisfaction`), by design (Goodhart §1) | `contract-leaves.ts#runBenchmark` |
| FMS → L2 (LoRA dataset) | yes, manual | `dispatch.ts rsi_lora_train` |
| FMS → L3 (receipts pick the next experiment) | yes, dev mode | `boot.ts maybeCodeRsiRound` |
| Candidate → eval → Rust score → I8 floor → I6 gate → strict-greater | yes (gate was skipped each episode — fixed) | `ratchet-handler.ts`, `repo.rs` |
| Champion → live agent | temperature + style addendum only | `champion.ts`, `agent-loop.ts` |
| Champion's live effect → measured | **no** (`monitor` leaf is a pass-through) | `contract-leaves.ts` |

The loop is closed through a static eval suite, not through the user's
experience. That is the design (spec §1), but it means evolution optimises
Tier 0/1/2 trivia under a short eval prompt, then applies the winner to a 31k
character live prompt on long tasks.

## What reaches the live agent

- L1 genome: `temperature` (every session, below the UI override; cloud
  clamps to 1.0) and `systemPromptId` → style addendum (owner prompt, new
  sessions only). The other five are `dropped` in `LIVE_REACH`; eval now grades
  `contextWindowUsage` at its neutral value.
- L6 MetaGenome: nothing live. It steers L1's search (mutation sigma, wild
  fraction, selection pressure, gate strictness tighten-only, `dream_batch`).
- L5: gates, budgets and freezes on the engine.
- L4: a `retrieval_strategy` module ranks the `recall` TOOL only (not the
  per-turn injection); a `planner` module has no live consumer at all.
- L2: a promoted adapter serves the local model (manual, gated).
- L3: a patch reaches the source tree after a human approves it, then a
  rebuild.

## Fixed (do not redo)

- `ff1f9f7` FMS: a built tree dropped "Known facts about the user" and the
  graph block from every turn.
- `1acde0f` FMS: after `init()` the tree never rebuilt again; the cap kept the
  OLDEST rows (200 by default on cloud); `episodic.all` did too.
- `611e0e0` I6: the first candidate of EVERY dream episode bypassed the
  confidence gate. The champion's outcomes now persist in `champion.json`.
- `ff2740e` Extinction could cull the ratcheted champion.
- `3531aa3` L3 code patches (0..100) and L1 genomes (0..55) shared `main`:
  one code promotion froze config evolution. Separate `code-main`, recovery
  from the audit chain, ratchet lock.
- `267ffe2` `rsi_status` showed the newest candidate as the champion.
- `6bc678f` Eval rewarded `contextWindowUsage` (409 vs 921 tokens for the
  same live agent).
- `bf07964` One birth in eight was a clone of its parent.
- `6242637` `CINDERPAW_RSI_STOP_ON_ACTIVITY` was read by nothing.
- `c32b661` L6 scored each episode summary as a reckless accept, cancelling
  the sound one.
- `5e3e31f` Code patches could edit `adapters.ts` / `sidecar.ts` /
  `champion.ts` (scorer input, gate thresholds, gate baseline).
- `f08198d` L4 retrieval modules were paired against no memory at all.

## Known and NOT fixed

- **Model switch.** `main`'s score and the gate baseline carry no model id.
  After a switch to a weaker model nothing ratchets; to a stronger one, the
  first candidate wins on the model, not the config. Fix: store the model on
  the champion and re-measure the champion first when it differs.
- **Taste layer measures itself.** It pairs consecutive commits across every
  candidate branch as (winner, loser); they are not. Weight ≈ 0.05, so the
  effect is small noise. Fix: mine (new champion, replaced champion) pairs
  from `RatchetAdvanced`.
- **Crossover never fires.** Genome commits have no parents, so `rsi_lca`
  finds no ancestor. Enabling it (pass lineage commit hashes) changes the
  search and needs a decision.
- **`RecalcitranceHigh`** is emitted and nothing listens; the per-episode
  tracker rarely sees the five ratchets its baseline needs.
- **Each episode re-evaluates the four default seeds**, dead ones included:
  `GoalMode` queues ids before the population snapshot is restored.
- **LoRA eval swaps the adapter on the live model**: a chat during the
  candidate run is answered by an unapproved adapter.
- **Reactive fact leaves** leave the tree at the next rebuild/restart (the
  fact still reaches every turn through the facts block).
- **Journal fitness vector**: `latency`/`cost` are `1 - score/100` (not
  measured) and `accuracy` is scaled by 100 while the scorer tops at 55.
- **Dead schema**: `rsi_genome`, `rsi_iteration`, `rsi_lineage`,
  `rsi_hall_of_fame` are created and never read or written.
- **FMS rebuild runs at boot only**; a process that lives for days serves new
  episodic rows through FTS5 alone until the next start.
- **`docs/agents-memory/`** (every topic file AGENTS.md indexes) is not in the
  repository.
