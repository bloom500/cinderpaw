# Launchers — Windows dev / bench entry points

Single source of truth for the `.bat` launchers that drive `cargo tauri dev`
on Windows. Every launcher follows the same skeleton:

```bat
@echo off
REM 1. VS2022 BuildTools env (vcvars64.bat) — cl 14.44, NOT VS18 preview.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
REM 2. Force CMake → Ninja (the Ninja that ships with VS2022 BuildTools lives
REM    under Common7\IDE\, not the VC root, so it has to be prepended to PATH).
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"
REM 3. FERAL_* knobs — the actual reason this launcher exists.
REM 4. cargo tauri dev (with optional --features).
```

Status legend:

- **active** — the launcher is committed and runnable from the repo root.
- **deleted** — removed in the consolidation; the recipe below is preserved so
  the exact env vars and cargo command can be reconstructed if needed.

All deleted launchers share `cd /d D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri`
(the old worktree path — adjust to `D:\FeralLocalAI\src-tauri` for the current
main checkout) unless otherwise noted.

---

## Active

### `run-app-ui-gpu.bat`  (repo root)

GPU dev launcher — builds with `--features inference-vulkan` so chat
inference uses the GPU. Same Windows toolchain recipe as the other
launchers (cl 14.44, Ninja, short `CARGO_TARGET_DIR=D:\fb`). The host
auto-detects fragile AMD GPUs (RX 580 / Polaris / early-Vega) at startup
and forces the embedding path to CPU, so embeddings won't crash on this
class of card — see `project_local_models_gpu.md`. Chat (VibeThinker-3B,
~1.8 GB) DOES use the GPU fine.

**Env:**

```
CARGO_TARGET_DIR=D:\fb
```

**Command:**

```bat
cd /d "D:\FeralLocalAI\src-tauri"
cargo tauri dev --features inference-vulkan
```

The launcher does NOT preset `FERAL_EMBED_GPU_LAYERS` — let the host's
auto-detection decide. To override manually, set it before invoking the
launcher and the host will leave it alone.

---

### `run-dream-test.bat`  (repo root)

The Dream Cycle dev launcher. Builds + runs the app from `D:\FeralLocalAI`
(NOT the old `wt-29286b1b` worktree) with the RSI scheduler tuned SHORT so a
full dream cycle is observable in ~1 minute. Local-only (cloud refused unless
`FERAL_RSI_ALLOW_CLOUD` is also set).

**Env:**

```
FERAL_RSI_PASSIVE=true
FERAL_RSI_IDLE_MS=15000
FERAL_RSI_COOLDOWN_MS=30000
FERAL_RSI_POLL_MS=5000
FERAL_RSI_EPISODE_MS=60000
FERAL_RSI_ERROR_THRESHOLD=2
FERAL_RSI_MAX_COST_USD=0
FERAL_FRACTAL_BENCH_MAX_LEAVES=200
FERAL_EMBED_GPU_LAYERS=0
FERAL_EMBED_CHUNK=32
```

**Command:**

```bat
cd /d "D:\FeralLocalAI\src-tauri"
cargo tauri dev
```

Telemetry lands at `%USERPROFILE%\.feral\rsi\dream.jsonl`.

---

## Deleted (preserved recipes)

The following 6 launchers were deleted in the consolidation. Their env-var
recipes and exact `cargo tauri dev` invocations are recorded here so any
re-introduction doesn't lose the calibration history.

### `run-app-ui.bat`  *(deleted)*

UI mode with RSI passive ON, $2 cost cap, bench cap 200 leaves so the rebuild
stays cheap. The default dev launcher.

**Env:**

```
FERAL_RSI_PASSIVE=true
FERAL_RSI_MAX_COST_USD=2.00
FERAL_FRACTAL_BENCH_MAX_LEAVES=200
FERAL_EMBED_GPU_LAYERS=0
FERAL_EMBED_CHUNK=32
```

**Command:**

```bat
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
```

### `run-app-ui-prod.bat`  *(deleted)*

PROD profile: NO `FERAL_FRACTAL_BENCH_MAX_LEAVES` (full 2697-leaf rebuild),
RSI off, MiniMax cloud router via wrapper. Tree-builder's
`MAX_CLUSTER_ITEMS_CHARS` cap keeps each cluster-summary request inside the
provider's context window.

**Env:**

```
FERAL_RSI_PASSIVE=false
FERAL_EMBED_GPU_LAYERS=0
FERAL_EMBED_CHUNK=32
```

**Command:**

```bat
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
```

### `run-bench-cpu.bat`  *(deleted)*

CPU fractal bench — `FERAL_RUN_FRACTAL_BENCH=1` with `FERAL_FRACTAL_BENCH_COUNT=12`,
RSI off, embed chunk 32.

**Env:**

```
FERAL_RUN_FRACTAL_BENCH=1
FERAL_FRACTAL_BENCH_COUNT=12
FERAL_FRACTAL_BENCH_MAX_LEAVES=200
FERAL_EMBED_GPU_LAYERS=0
FERAL_RSI_PASSIVE=false
FERAL_EMBED_CHUNK=32
```

**Command:**

```bat
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
```

### `run-bench-gpu.bat`  *(deleted)*

Headless GPU bench with short target dir to dodge Windows MAX_PATH (260) in
llama.cpp's nested `vulkan-shaders-gen` cmake build. All GPU layers (999)
loaded onto the GPU.

**Env:**

```
CARGO_TARGET_DIR=D:\fb
FERAL_RUN_FRACTAL_BENCH=1
FERAL_FRACTAL_BENCH_COUNT=12
FERAL_EMBED_GPU_LAYERS=999
```

**Command:**

```bat
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev --features inference-vulkan
```

### `run-bench-minimax.bat`  *(deleted)*

CPU + MiniMax M3 (cloud query-gen via `FERAL_*` env), RSI off, embed chunk 32.

**Env:**

```
FERAL_RUN_FRACTAL_BENCH=1
FERAL_FRACTAL_BENCH_COUNT=12
FERAL_FRACTAL_BENCH_MAX_LEAVES=200
FERAL_EMBED_GPU_LAYERS=0
FERAL_RSI_PASSIVE=false
FERAL_EMBED_CHUNK=32
```

**Command:**

```bat
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
```

### `run-bench-minimax-b16.bat`  *(deleted)*

Fractal Memory Search bench — BRANCH=16 sweep on the full 2700-leaf corpus.

Baseline to beat (branch=8, 2700 leaves, seed=1, k=10, n=12):

```
fractal recall@10 = 0.417   p99 = 32ms   SHIP
fts     recall@10 = 0.083   p99 = 100ms
```

A material jump (>0.50) → topology was the limiter; freeze a JSONL and
publish. Flat (~0.40) → embedding is the ceiling; bge-large is next.

Branch=8 tree + report backup locations:

```
%USERPROFILE%\.feral\agent\fractal-tree.branch8.bak.json
%USERPROFILE%\.feral\agent\fractal-bench-report.branch8.bak.json
```

The launcher deletes any cached `fractal-tree.json` before starting (otherwise
`rebuildIfStale()` is a no-op while the branch=8 tree still covers all 2700
leaves and the sweep runs against the OLD topology).

**Env:**

```
FERAL_TREE_BRANCH=16
FERAL_RUN_FRACTAL_BENCH=1
FERAL_FRACTAL_BENCH_COUNT=12
FERAL_FRACTAL_BENCH_SEED=1
FERAL_EMBED_GPU_LAYERS=0
FERAL_RSI_PASSIVE=false
FERAL_EMBED_CHUNK=32
```

**Pre-step:**

```bat
if exist "%USERPROFILE%\.feral\agent\fractal-tree.json" del /q "%USERPROFILE%\.feral\agent\fractal-tree.json"
```

**Command:**

```bat
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
```

New report → `%USERPROFILE%\.feral\agent\fractal-bench-report.json`.

---

## Adding a new launcher

1. Pick the closest existing recipe above as a template (the skeleton is
   identical for every profile).
2. Adjust `FERAL_*` knobs only — DO NOT touch the `vcvars64` call or the Ninja
   PATH prepend unless you have a reason that survives "the build still
   references the right `cl.exe`/ninja.exe on a fresh shell".
3. Run from the repo root (`D:\FeralLocalAI`), not from inside `src-tauri`.
4. After confirming the launcher works for one full cycle, append it to this
   doc under **Active** with its exact env + command.