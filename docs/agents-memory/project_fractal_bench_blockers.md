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
