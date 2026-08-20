# RSI E2E Manual Verification

**Status:** Faza 1 integration is committed (5 commits on `feat/rsi-fractal-memory`),
unit-tested (720 CinderpawAgent + 146 Rust tests pass), and the sidecar builds + runs.
**End-to-end verification with a live model + the React UI is the operator's
manual step.** This file is the runbook.

## What "e2e" means here

A successful run fires the full async RSI engine — Faza 1 (ratchet),
Faza 2 (crossover/extinction), Faza 3 (escape-time/taste) — over
the production wiring (bridge + sidecar + transport), observes the
events in the React `/rsi` page, and captures real cost / timing
numbers that go into PLAN.md.

## Prerequisites

1. **Rust toolchain** — `cargo --version` should print a version.
2. **Bun** — `bun --version` should print ≥1.0.
3. **A local model loaded** — the bundled `qwen2.5:7b` is the
   default; smaller (e.g. `qwen2.5:0.5b`) is fine for a smoke.
   The Tauri shell starts the bundled llama.cpp engine on
   `http://127.0.0.1:11435` automatically; override with
   `FERAL_MODEL=... FERAL_BASE_URL=...` for an external provider.

## Step 1 — build the sidecar

```bash
cd CinderpawAgent
bun run build
node ../src-tauri/scripts/build-sidecar.mjs
```

The script copies `CinderpawAgent/dist/feral-agent.exe` →
`src-tauri/binaries/feral-agent-<triple>.exe`. Cargo's
`beforeDevCommand` does this automatically — only run by hand
when iterating without `cargo tauri dev`.

## Step 2 — start the Tauri dev shell

```bash
cd src-tauri
cargo tauri dev
```

The first compile takes ~5–10 minutes (release would be slower).
Once the React UI loads, the `/rsi` sidebar item is the entry
point for the RSI page.

## Step 3 — open the RSI page

Navigate to `/rsi`. The page shows:

- **Substrate card** — bounds sha256, version, max cost, current
  cost. Should populate within a second of sidecar boot.
- **Engine mirror card** — `running: false` until you click Start.
- **Goal form** — `goal` text, `maxIterations` (default 50),
  `maxTotalTokens` (default 5M), `concurrency` slider.
- **Live event feed** — bottom of the page.

## Step 4 — start a short goal

Suggested first run (cheap):

- goal: `smoke-test`
- maxIterations: 4
- maxTotalTokens: 200_000
- concurrency: 1

Click **Start**. Within ~2 seconds you should see:

1. An `rsi_engine_event { event: "started", concurrency: 1 }` line.
2. A flood of `rsi_engine_event { event: "progress", genomeId, score }`
   lines — one per `EvalComplete`.
3. The first `RatchetAdvanced` line within a handful of iterations.
4. `GenomeBorn` lines as the selection handler fills slots.

When the engine hits its stop condition (TargetReached /
MaxIterations / BudgetExhausted / PlateauPersistent / UserStopped),
you see `rsi_engine_event { event: "stopped", iteration, bestScore,
stopReason }`.

## Step 5 — verify Faza 2/3 wiring

For Faza 2 (crossover) and Faza 3 (escape-time / taste) to fire,
the run must last long enough for the population to grow. A
short demonstration:

- goal: `crossover-demo`
- maxIterations: 30
- maxTotalTokens: 2_000_000
- concurrency: 4 (so the worker pool drains faster)

Watch the event feed for:

- **Crossover birth** — a `GenomeBorn` with
  `mutationType: "crossover"`. Requires two related + divergent
  genomes (LCA over `rsi_lca` returns non-null).
- **Wild explorer birth** — `GenomeBorn` with
  `mutationType: "wild"`. The 5% wild-explorer probability; expect
  ~1 per 20 births.
- **Extinction event** — `ExtinctionTriggered` with
  `reason: "adaptive"` (monoculture + plateau) or
  `reason: "periodic"` (every 20 evals). Followed by a batch of
  `GenomeDied` lines.
- **RecalcitranceHigh** — emitted when the moving-average
  improvement_difficulty exceeds 3× the baseline. Indicates the
  search is hitting diminishing returns; Fractal Search zooms out.

## Step 6 — record cost + timing

The engine's `totalTokens` and per-eval `tokenCost` come from the
InferenceRouter (source of truth). Capture these per run:

- Wall-clock time per eval (run `time` over `cargo tauri dev`).
- Total tokens consumed (engine_event carries `costSoFarUsd`).
- Final `bestScore` and `stopReason`.

Update `PLAN.md` "Empirical" section with the numbers.

## Step 7 — bump concurrency live

While a run is in progress, drag the concurrency slider from 1
to 4. You should see:

- `rsi_engine_event { event: "concurrency_set", concurrency: 4 }`
  within ~1 second.
- The number of in-flight evals climbs (visible in the engine
  mirror card or by counting `EvalStarted`/`EvalComplete` deltas).

Lowering concurrency does NOT cancel in-flight evals — they
finish naturally. Raising concurrency fills new slots on the next
slot-free callback.

## Step 8 — stop

Click **Stop**. The engine enters `UserStopped` mode, drains
in-flight evals (no kill mid-flight — see `goal-mode.ts` for the
rationale), and emits `stopped` with `stopReason: "UserStopped"`.

## What to write back

Add a note to the HANDOFF / PLAN.md with:

- Final `bestScore` and `stopReason`
- Total `costSoFarUsd` and wall-clock duration
- Counts of: EvalComplete, RatchetAdvanced, GenomeBorn (by
  mutationType), GenomeDied, ExtinctionTriggered
- Any errors observed in the sidecar stderr (redirected by
  `cargo tauri dev` to the Tauri console)

## Known sharp edges

- **Bridge timeout** — the first bridge call after sidecar boot
  may take ~500ms while the Rust dispatcher warms up. The
  adapter uses `ack-with-timeout` (500ms default) and retries
  once; transient failures resolve without surfacing to the user.
- **Stale git substrate** — if `~/.feral/rsi/` was created by
  an old build (pre-bounds-fix), `rsi_start` may fail with a
  bounds mismatch. Clear with
  `Remove-Item -Recurse -Force "$env:USERPROFILE\.feral\rsi"`.
- **First eval is slow** — the model's KV cache cold-starts on
  the first prompt. Expect the first eval to take 2-3× longer
  than subsequent ones.
- **Plan mode error** — `rsi_start` rejects with `plan not found`
  if PLAN.md is missing from the substrate. Re-init via
  `rsi_init` (manual Tauri command).

## What this e2e does NOT cover

- **PBT (Faza 3.5)** — separate phase owned by Opus.
- **Mandelbrot (Faza 4)** — strategy genome ↔ engine genome
  translation layer. Future work.
- **Multi-sidecar concurrency** — the substrate's Rust-side
  file locking assumes a single sidecar process per workspace.
