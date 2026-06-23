# Local Models & GPU

**Status:** Canonical CPU-only — Vulkan embed is permanently unstable on this
dev box (RX 580 + llama.cpp × AMDVLK). `FERAL_EMBED_GPU_LAYERS=0` is the
documented canonical path.
**Date:** 2026-06-23 (Pathway 4 PR-C C.5 confirmed CPU-only as permanent)
**Branch / worktree:** `feat/pathway4-prC-c0-leafstore` @ `D:\FeralLocalAI\.worktrees\wt-p4C0`

## TL;DR

- The sidecar **detects** the GPU and offers it as the embedding target.
- On RX 580 + Vulkan, **bge-small crashes at model load**
  (`STATUS_ACCESS_VIOLATION`) — this is an env bug, not a code bug.
- Workaround: `FERAL_EMBED_GPU_LAYERS=0` forces CPU offload for embeddings.
- Chat inference (VibeThinker-3B) on the same GPU is stable enough for
  RSI to run; it's the embed-only path that breaks.

## Models on disk (this dev box)

| Model           | Role        | Size  | Status                                 |
|-----------------|-------------|-------|----------------------------------------|
| `bge-small`     | embedding   | ~30MB | ❌ crashes on Vulkan load              |
| `VibeThinker-3B`| chat        | ~1.8GB| ✅ stable on GPU                       |

## The "wrong chat model" footgun (now fixed)

`discover_active_model` scans the models directory and picks the first
alphabetical entry. On NTFS, lowercase `b` sorts **before** uppercase `V`,
so it picked `bge-small` as the chat model. Symptom: RAPTOR cluster
summaries and bench query-gen produced garbage (bge is an embedding
model, not a chat model), and the build looked like it was working but
everything downstream was nonsense.

**Fix:** the discovery now prefers chat-shaped model files (or excludes
known embed-only files). Pinned to `VibeThinker-3B` in this env. ✅

## The "GPU embed crashes" footgun

`FERAL_EMBED_GPU_LAYERS=0` forces CPU offload for embeddings. Symptom
without it: a single embed call triggers a Vulkan driver crash inside
llama.cpp; the sidecar logs `STATUS_ACCESS_VIOLATION` and the request
never returns. The Settings bench button would then hit the 15-min build
timeout because the embed phase never completes.

Other things tried that **did not help** on RX 580:

- Bumping the Vulkan SDK to 1.3.x
- Reducing GPU layers to 1 (still crashed at load, not at run)
- Disabling the ANGLE backend

This is almost certainly a llama.cpp × AMDVLK × RX 580 driver bug, not
something we can patch from the Feral side.

## Knobs that actually matter in this env

| Env var                       | What it does                              | Default |
|-------------------------------|-------------------------------------------|---------|
| `FERAL_EMBED_GPU_LAYERS=0`    | CPU-only embedding (bypasses Vulkan bug)  | (unset) |
| `FERAL_RUN_FRACTAL_BENCH=1`   | Auto-run the Fractal bench on startup     | (unset) |
| `FERAL_FRACTAL_BENCH_QUERIES` | Path to a hand-authored JSONL query set   | (unset) |

## What this blocks

- **Fractal Memory rebuild** at scale. CPU embed ≈ 2.8 s/text → 2697 leaves
  × 2.8 s = ~2 hours. The 15-min `buildTimeoutMs` in the Settings button
  will always trip. (See `project_fractal_bench_blockers.md`.)
- Real end-to-end timing numbers for the bench. The bench logic itself
  is correct and unit-tested; the blocker is purely "embed is too slow
  to ever finish in a useful window".

## What would unblock it

- A different GPU (anything NVIDIA, or a newer AMD card where the Vulkan
  driver is current).
- A pre-built llama.cpp where the embed path is patched to skip the
  GPU load entirely for `bge-small`-shaped models.
- A corpus subset small enough that 2.8 s × N fits in the timeout (rule
  of thumb: ≤ 300 leaves for a 15-min budget on this box).
