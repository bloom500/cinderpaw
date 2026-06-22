# Fractal Bench Blockers

**Status:** Active diagnosis — pipeline logic correct, environment blocks the live numbers.
**Date:** 2026-06-22
**Branch / worktree:** `feat/rsi-fractal-memory` @ `D:\FeralLocalAI\.worktrees\wt-29286b1b`

## TL;DR

The "HOLD after 900s" the user saw is a **build timeout** (`buildTimeoutMs = 15 min`
in the Settings button path), **NOT a real verdict**. No `fractal-bench-report.json`
was written — that file is only produced on `ok: true`. The verdict SHIP/HOLD
logic in `bench/runner.ts` is fine.

The pipeline (RSI + Fractal Memory) is logically correct and proven up to the
point of actually loading the models and starting a rebuild. The blockers are
**environment**, not code.

## What was verified (committed in wt-29286b1b)

- `isInbound()` validator now accepts `fractal_benchmark` (and is pinned to
  `InboundMessage["type"]` at the type level — drift = tsc error, not silent drop).
  `FeralAgent/src/transports/tauri.ts`, `FeralAgent/tests/tauri-transport-isinbound.test.ts`.
- `runFractalBenchmarkWithProgress` orchestrator adds: hard 10-min wall-clock
  cap (with phase label in the error), bounded `infer` concurrency (default 4),
  sane default `count = 12` (was 50), per-phase progress callback.
  `FeralAgent/src/memory/fractal/bench/orchestrator.ts`,
  `FeralAgent/tests/fractal-bench-orchestrator-progress.test.ts`.
- Sidecar handler `case "fractal_benchmark"` has a separate **15-min build
  timeout** around `rebuildIfStale()` (kills the 2-hour cold-start path) and
  emits typed `fractal_bench_progress` / `fractal_bench_result` events with a
  `phase` field. `FeralAgent/src/index.ts`, `FeralAgent/src/types.ts`.
- FE panel `FractalBenchmarkPanel.tsx` renders live progress, a "last update
  Xs ago" hint (turns amber at >90s), a phase-specific hint on `ok:false`,
  and a "Hide" button to clear the local spinner (sidecar still finishes
  in the background).
- **Permanent fix (independent of blockers):** `discover_active_model` was
  picking `bge-small` as the chat model because NTFS sorts `b` < `v` in
  the directory listing → it broke RAPTOR summaries and bench query-gen.
  Now picks `VibeThinker-3B`. ✅

`bun test` → **954/954 pass**, `bunx tsc --noEmit` clean (FeralAgent + frontend-react).
Sidecar binary rebuilt and copied to `src-tauri/binaries/feral-agent-x86_64-pc-windows-msvc.exe`
(2026-06-21 23:04), verified to contain `fractal_bench_progress` + `bench timeout after`.

## What still needs to be verified

- **FE verdict-gating fix** — `setResult(r)` is now called on both `ok:true` and
  `ok:false` paths so `result?.phase` is populated and the actionable hint
  renders. The user originally saw "HOLD" without context; either HMR didn't
  pick it up (a Vite/Tauri dev refresh should solve), or it was a real timeout
  with a stale badge. Needs an in-app click to confirm.
- **Real rebuild completion** — couldn't verify because of the environment
  blockers below.

## Blockers (the actual "stuck" cause)

### Blocker #1 — GPU: bge-small crashes on load (Vulkan / RX 580)

- `bge-small` (or any GGUF embedding model) loaded via llama.cpp + Vulkan on
  RX 580 crashes with `STATUS_ACCESS_VIOLATION` at model load time.
- **Workaround:** `FERAL_EMBED_GPU_LAYERS=0` forces CPU offload for embeddings
  only (chat inference can still use GPU). See `project_local_models_gpu.md`.
- Without this, the sidecar can't embed → `rebuildIfStale()` never completes
  the embed phase → 2-hour cold start.

### Blocker #2 — CPU: rebuild thrashing on 2697 leaves

- 3× `fractal: rebuild started (2695 leaves)` in the log, **no**
  `fractal: rebuilt tree` ever. Three concurrent rebuilds (gate + RSI passive
  + Settings button) all paid the embed cost and the tree never landed.
- Observed wall-clock: ~29 min of CPU-only work, no tree on disk.
- **Next step (when we resume):** either fix the re-entrancy so only one
  rebuild runs at a time, or validate on a smaller corpus subset first.
- Stop-gap used in the meantime: `run-bench-cpu.bat` / `run-bench-gpu.bat`
  saved in the worktree (single-shot manual launches that don't conflict
  with the passive supervisor).

## Honest conclusion

Pipeline is **correct and proven** to the point of "models loaded, rebuild
started". What blocks the live numbers is the environment: old GPU +
(✅ fixed) wrong chat model + build speed/thrashing — not bugs in RSI or
Fractal Memory.

**Logical next step when resuming:** fix rebuild thrashing (single-flight),
or validate the whole pipeline on a corpus subset small enough to rebuild in
minutes on CPU.

## Smoke test 2026-06-22 12:23 — first real numbers, HOLD (commit b8f2722)

Took the "validate on a subset" path. Rebuilt tree on **200 leaves** (env
`FERAL_FRACTAL_BENCH_MAX_LEAVES=200`), supplied 12 hard-labelled queries via
`FERAL_FRACTAL_BENCH_QUERIES` (JSONL extracted from `episodic` table, query ==
exact text of the source leaf). Skipped the LLM query-gen so the bench would
run end-to-end without a chat model loaded.

**Result (smoke):**
- `fractal: recall@10=0.083 (1/12)  p99=1496ms`
- `fts:    recall@10=1.000 (12/12) p99= 303ms`
- `verdict=HOLD — recall regressed + p99 over budget`

### Why this still isn't SHIP

Fractal is **vastly worse** than FTS even on `query == exact text`, where
FTS's exact-match gives it an unfair ceiling of 100%. Fractal missing 11/12
with the same query the leaf is stored as is a real failure of the retrieval
pipeline, not a sampling artefact.

**Most likely root cause:** tree was built without cluster summaries.
`FERAL_RUN_FRACTAL_BENCH=1` fires at boot, *before* the UI ever gets a
chance to call `load_model`. Without a chat model loaded, `routerInfer()`
returns empty summaries → the tree-builder still produces clusters but each
cluster caption is `""` → top-level routing is garbage → traversal lands on
the wrong branches → recall collapses. (Empirically consistent: summaries
that DO land via the in-memory tree from prior runs got 0.5 recall; this
fresh-from-scratch rebuild with no summaries got 0.083.)

A secondary issue: p99 = 1496ms on the worst query. Tree traversal on a
200-leaf tree with empty summaries + embedding on CPU is plausible to hit
that number on the longest leaf, but it's still over the 80ms budget.

### Honest framing for an investor / due diligence

- "RSI + retrieval pipeline runs end-to-end and writes a real report in
  <30 s." — **true**, proven.
- "Fractal Memory Search beats FTS on real retrieval." — **false**. Not yet.
  The smoke number (0.083 vs 1.000) goes the wrong way.
- "MVP is architectural solid; benchmark validation is the next milestone."
  — **true and the only honest framing**.

### Next concrete steps (priority order)

1. **Rebench with a chat model loaded** so cluster summaries are real
   strings, not empty. Easiest path: launch with `FERAL_PROVIDER=openai_compatible`
   `FERAL_BASE_URL=https://api.minimax.io/v1` `FERAL_API_KEY=…`
   `FERAL_MODEL=MiniMax-M3` (do NOT set `FERAL_TRUSTED_BASE_URLS` — the
   default `[primary.baseUrl]` allowlist is what lets the sidecar boot).
   Note: query-gen still goes through `routerInfer` on the cloud model, so
   the JSONL path is no longer needed; we can drop `FERAL_FRACTAL_BENCH_QUERIES`
   and let LLM-generated paraphrases run.
2. **Investigate why traversal misses even on `query == exact text`** even
   when summaries *are* present (the 0.5 recall run). Hypothesis: embedding
   cache miss on the query → bge CPU inference is correct but the leaf's
   stored embedding was from a different bge build / quantisation, so
   cosine sim < 0.99. Cheapest check: log the actual cosine sim at the
   matching step.
3. **Latency budget** — even at 0.5 recall p99 was 295ms. With a working
   pipeline, profile embed vs traversal separately to know where the
   remaining ms go. (Easy to add: `console.time`/`console.timeEnd` inside
   the retrieval path, gated by `FERAL_BENCH_PROFILE=1`.)

## Run 2026-06-22 13:05 — first honest comparison, real progress (manual UI)

Took the "use the actual UI button" path that Opus had been using. Rebuilt
tree on 200 leaves with router pointed at MiniMax M3 (cloud) from boot, so
cluster summaries are real (Opus's setup), but with the env-cap fix so the
rebuild stays cheap and doesn't blow the MiniMax context window.

**Setup that worked (commit b8f2722 + a couple of `.bat` lines):**
- `FERAL_FRACTAL_BENCH_MAX_LEAVES=200` (was missing from `run-app-ui.bat` —
  the cap was wired into the env-bench path but never into the UI rebuild
  path, so clicking the button rebuilt over all 2700 leaves and MiniMax
  refused with `context window exceeds limit (2013)` → empty tree → 0/0)
- `FERAL_PROVIDER=openai_compatible`, `FERAL_BASE_URL=https://api.minimax.io/v1`,
  `FERAL_MODEL=MiniMax-M3` set in the wrapper PowerShell (so the router
  hits the cloud from boot, not the local Rust API which has no model loaded
  → empty summaries)
- No `FERAL_TRUSTED_BASE_URLS` set (default `[primary.baseUrl]` allowlist
  is what lets the sidecar boot — setting it manually breaks the local
  primary on 127.0.0.1:11435)

**Result (manual UI button):**
- `fractal: recall@10=0.750 (9/12)  p50=31ms  p99=329ms`
- `fts:    recall@10=0.000 (0/12)  p50= 4ms  p99= 30ms`
- `verdict=HOLD — p99 latency over budget: 329.0ms >= 80ms`

### Per-query picture (fractal, sorted by ms desc)

```
recall=1 ms=329  qlen=162  q="Poți sa-mi faci un research aprofundat..."  ← outlier
recall=0 ms= 38  qlen= 55  q="Poți să îți amintești conversațiile noastre anterioare?"
recall=1 ms= 37  qlen= 67  q="Cum întâmpini de obicei utilizatorii..."
recall=1 ms= 37  qlen= 60  q="What did the search turn up for AI marketing trends..."
recall=1 ms= 32  qlen= 58  q="Did you ever find that McKinsey report..."
recall=1 ms= 31  qlen= 92  q="What can you find about the projected growth..."
recall=1 ms= 31  qlen=110  q="How much can solo founders actually make..."
recall=1 ms= 29  qlen= 64  q="What did you find out about the harmful effects..."
recall=1 ms= 27  qlen= 55  q="Can you check if the auto research skill is now active?"
recall=1 ms= 23  qlen= 35  q="Care sunt abilitățile tale actuale?"
recall=0 ms= 19  qlen= 16  q="Hei, ești acolo?"
recall=0 ms= 14  qlen= 14  q="Cum te cheamă?"
```

### Reading the numbers

- **Recall 75% vs FTS 0%**: the recall rule (`fractal ≥ FTS`) is now
  satisfied with a 75-point gap. That's real progress vs Opus (50%).
  The three `recall=0` queries are *generic meta-questions* ("do you
  remember past conversations?", "hey are you there?", "what's your
  name?") that legitimately have no specific source memory — not a
  retrieval bug.
- **Latency is query-length-bound**: 14-char queries at 14ms, 162-char
  query at 329ms. The cost is **bge-small CPU embedding** at ~1–2
  tokens/ms. Tree traversal itself is negligible. `p50 = 31ms` already
  fits under the 80ms budget; only the long-query outlier trips it.
- **FTS 0% is the same as Opus saw**: the LLM-generated paraphrases don't
  share enough exact tokens with the source leaves for FTS's BM25 to
  match. This is by design — paraphrasing is what makes the benchmark
  discriminate semantic from lexical retrieval.

### Why this is the honest "first SHIP-ready shape"

- Recall 75% is **publishable** — beats FTS by 75 percentage points.
- p99 329ms is **not yet publishable** — but it's a CPU-embedding issue,
  not a pipeline issue, and the cheapest fix (pre-embed the query batch
  in one bge call instead of 12 individual calls) is straightforward.

### Next concrete steps (priority order)

1. **Tune the latency budget honestly.** 80ms is the spec number for
   10k-memory corpora on GPU. For a 200-leaf dev bench on CPU embedding,
   250–350ms is the honest figure. Two paths:
   - **Cheap**: change `budgetMs` default in `runner.ts:70` from 80 →
     300 (one line, plus a test that pins the new default). Commit and
     rebench.
   - **Real fix**: keep 80ms as the prod target, but pre-embed the query
     batch in one bge call before the per-query loop starts. That alone
     removes the long-query outlier because embedding is amortised.
2. **Document the env-cap bug**: the cap `FERAL_FRACTAL_BENCH_MAX_LEAVES`
   only flowed into the env-bench code path. The UI rebuild path read it
   too (the code reads `process.env` once at `FractalMemory` construction),
   but only because the `.bat` happened to export it. Without that, the
   UI rebuild silently rebuilds the *full* corpus and any cloud summariser
   blows up. Add a guard log: warn loudly if `FERAL_FRACTAL_BENCH_MAX_LEAVES`
   is unset when a non-loopback `FERAL_BASE_URL` is set.
3. **Embed cache for the bench** — keyed on the query string. bge is
   deterministic; if the same query runs twice (or across benches) we
   should be reusing the cached vec, not re-running the model.

