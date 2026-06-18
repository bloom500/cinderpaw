# RSI Faza 1 — Handoff to M3

**Branch:** `feat/rsi-fractal-memory` (worktree `D:/FeralLocalAI/.worktrees/wt-29286b1b`). Nothing on `main`.
**Source of truth:** `src-tauri/src/rsi/plan.rs` (`PLAN_MD`) — read it first.
**Tests green:** 131 Rust (`cd src-tauri && cargo test --lib rsi::`) + 39 TS (`cd FeralAgent && bun test tests/rsi-*.test.ts`).

## Done (commits, newest first)
- `6c5d88d` enrich ratchet `commitGenome` dep → `{genomeId, score, tokenCost, durationMs}`
- `57cc7cc` 7b-part1: protocol-(a) bridge **client** TS (`src/rsi/bridge.ts`)
- `087067d` 7a: Goal Mode orchestrator (`src/rsi/goal-mode.ts`) — drives loop to StopReason
- `6bece65` 6: recalcitrance tracker (`src/rsi/recalcitrance.ts`)
- `7485fe7` 5b: selection/mutation handler (`src/rsi/selection-handler.ts`)
- `cd0616f` 5a: mutation grammar (`src/rsi/mutation.ts`, `genome.ts`)
- `8491095` 4: ratchet handler (`src/rsi/ratchet-handler.ts`)
- `21cf056` 3: eval worker (`src/rsi/eval-worker.ts`)
- `7a94400` 2: population manager (`src/rsi/population-manager.ts`)
- `7c8eaf1` 1: event bus (`src/rsi/event-bus.ts`)
- `260735f`+`162804e` Faza 0 (Rust boundary, hardened)

The full engine LOGIC is done + tested in TS (sequential, concurrency=1). All deps (`runEval`, `scoreGenome`, `commitGenome`, `ratchetAttempt`) are injected; only the real Rust/agent wiring remains.

## TODO — finish Faza 1 (7b-part2 → 7d)

### 7b-part2: Rust dispatcher + TS adapters (IN PROGRESS)
1. **`handle_rsi_request` in `src-tauri/src/feral_agent.rs`** — model on `handle_desktop_control_request` (same file). In `stdout_reader` add: if `type == "rsi_request"` → `tokio::spawn(handle_rsi_request(app.clone(), v, tx))`. The handler reads `app.state::<crate::AppState>()` and accesses `.rsi_state` **directly** (do NOT use `State<RsiState>` — see gotcha #1). Dispatch on `method`:
   - `rsi_score` → params `{outcomes: Vec<EvalOutcome>}`; weights from `st.rsi_state.bounds.lock()`; call `rsi::scorer::score`. Return `ScoreBreakdown`.
   - `rsi_commit_genome` → params `{genome_id, genome_json(string), parent_commits, metadata, candidate_branch}`; replicate validation from `commands.rs:rsi_commit_genome`; call `rsi::repo::commit_genome`. Return `{commitHash}`.
   - `rsi_ratchet_attempt` → params `{candidate_commit}`; call `rsi::repo::ratchet_attempt` (no state). Return `RatchetResult`.
   Write back `{type:"rsi_response", id, ok, data|error}` via `tx` (exactly one response per request).
2. **Wire response delivery in `FeralAgent/src/index.ts`** — the stdin reader must call `bridge.onResponse(msg)` when `msg.type === "rsi_response"` (mirror how `desktop_control_response` / `ask_user_response` are routed).
3. **TS adapters** (new `src/rsi/adapters.ts`): `makeRustScoreGenome(bridge)` and `makeRustGit(bridge, pop)`:
   - scoreGenome: map outcomes camelCase→**snake_case** (`taskId→task_id`, `latencyMs→latency_ms`, `errorMessage→error_message`) before sending; Rust `EvalOutcome` has no `rename_all`.
   - commitGenome `({genomeId,score,tokenCost,durationMs})`: `pop.get(genomeId)` for `config`(→`genome_json` via JSON.stringify), `lineage`, `mutationType`; build `metadata` snake_case `{score, strategy, parent_lineage, mutation_type, cost_tokens, duration_ms}`; `candidate_branch = "genome-"+genomeId` (single segment, not "main", no "/"); call bridge.
   - ratchetAttempt `(commitHash)`: bridge `rsi_ratchet_attempt {candidate_commit: commitHash}`; map result `previous_best→previousBest`.
   - **Add `mutationType?` field to the population `Genome`/`GenomeSpec`** and set it in the selection handler at birth (seeds = "seed"), so the commit adapter can read it.

### 7c: IPC + fix RsiState management
- **GOTCHA #1 (must fix):** `rsi_*` commands in `commands.rs` take `State<'_, RsiState>` but only `AppState` is `.manage()`d (`lib.rs:2549`). Change them to `State<'_, AppState>` + `.rsi_state` (and `.rsi_goodhart`), or they fail at runtime / read an empty instance. Update `ensure_initialized` accordingly.
- New commands: `rsi_start(goal, budget, maxIterations, concurrency)`, `rsi_stop`, `rsi_status`, `rsi_set_concurrency`. These drive the sidecar engine — likely send a command over stdin to the sidecar, which constructs the engine (recorder→ratchet→selection→recalcitrance→GoalMode wired in THAT order; recorder MUST be first EvalComplete subscriber) and runs it.

### 7d: minimal UI
- React page: goal input + budget + concurrency slider + start/stop + live score + event feed (subscribe to `feral://agent-output` for engine events). Replaces nothing yet (Mandelbrot is Faza 4).

### Follow-ups
- concurrency > 1 ramp in `GoalMode.run()` (currently sequential).
- `runEval` real implementation = agent loop over Tier 0/1/2 (Rust owns Tier 0 specs via `rsi_get_tier0_specs`).

## Gotchas
1. **RsiState not managed** (above). Bridge sidesteps by reading `AppState.rsi_state` directly.
2. Wire types cross the boundary as JSON; Rust structs are snake_case (no `rename_all`). Adapters convert.
3. `~/.feral/rsi` on dev machine had stale `$50` bounds from a pre-fix test — Darius to clear with `Remove-Item -Recurse -Force "$env:USERPROFILE\.feral\rsi"`.
4. Sidecar must `bun run build` + copy `.exe` to `src-tauri/binaries/` to take effect (see memory `sidecar_binary_flow`).

## Decisions locked (do not re-litigate)
- Protocol **(a)** request/response (not React-orchestrated).
- Mutation grammar corrected: temperature `[0, min(2.0, providerMaxTemp)]`; tool weights = transfer mutation (simplex); context `[0.1,0.95]`; depth random walk ±1; categorical fields = uniform resample.
- License → BSL 1.1 (Bloom Media / Apache 2.0 change license / non-production grant / 4yr) — **deferred**, not started.
