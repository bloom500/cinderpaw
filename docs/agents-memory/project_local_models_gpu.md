# Local Models & GPU

**Status:** Active — chat inference runs on GPU via the Vulkan build
(`run-app-ui-gpu.bat`); embeddings are auto-forced to CPU on fragile AMD
GPUs at startup so they don't crash.
**Date:** 2026-06-28
**Branch / worktree:** `feat/reactive-pixel-tree` @ `D:\FeralLocalAI`

## TL;DR

- The sidecar **detects** the GPU and offers it as the embedding target.
- On RX 580 + Vulkan, **bge-small crashes at model load**
  (`STATUS_ACCESS_VIOLATION`) — this is an env bug, not a code bug.
- Workaround (manual): `FERAL_EMBED_GPU_LAYERS=0` forces CPU offload.
- Workaround (automatic, since 2026-06-28): the host detects fragile AMD
  GPUs at startup and sets `FERAL_EMBED_GPU_LAYERS=0` for you. Honors
  any user preset env var.
- Chat inference (VibeThinker-3B) on the same GPU is stable enough for
  RSI to run; it's the embed-only path that breaks.

## How to run a GPU dev session

Pick the launcher that matches your hardware. From repo root:

```bat
run-app-ui-gpu.bat     :: AMD / Intel / any Vulkan-capable GPU
run-app-ui-cuda.bat    :: NVIDIA — faster on NVIDIA than Vulkan (cuBLAS/cuDNN)
```

Both launchers handle vcvars64 (Vulkan) or expect a pre-configured dev
prompt (CUDA), short `CARGO_TARGET_DIR=D:\fb`, and pass the matching
`--features inference-vulkan` / `--features inference-cuda` to
`cargo tauri dev`. Recipe details:
`docs/agents-memory/reference_windows_vulkan_build.md`.

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
| `FERAL_EMBED_GPU_LAYERS=0`    | CPU-only embedding (bypasses Vulkan bug). Auto-set on fragile AMD GPUs by the host at startup; pre-setting it explicitly wins over the auto-detect. | auto (AMD) |
| `FERAL_RUN_FRACTAL_BENCH=1`   | Auto-run the Fractal bench on startup     | (unset) |
| `FERAL_FRACTAL_BENCH_QUERIES` | Path to a hand-authored JSONL query set   | (unset) |

## Auto-detection (added 2026-06-28)

`gpu_detect::looks_like_fragile_amd_gpu` matches the GPU names that have
crashed in this dev env (RX 580 / 570 / 560 / 550 / 480 / 470 / 460,
Polaris, gfx803) plus the broader AMD families that share the legacy
AMDVLK / Mesa RADV driver path (Vega / RDNA / gfx8 / gfx9 / gfx10). The
heuristic is conservative: unknown names and non-AMD vendors are never
flagged. NVIDIA and Intel GPUs are never affected.

The check runs once in `setup()` on a Vulkan build (`cfg!(feature =
"inference-vulkan")`). If matched and the env var isn't already set,
`FERAL_EMBED_GPU_LAYERS=0` is applied and a tracing log line records the
reason — visible in the dev terminal.

**CUDA builds are NOT auto-overridden** — CUDA on NVIDIA is stable for
embedding, and CUDA + AMD isn't a thing, so the auto-CPU-offload logic
is intentionally scoped to Vulkan only.

## CUDA on NVIDIA (added 2026-06-28)

`inference-cuda` is a parallel Cargo feature alongside `inference-vulkan`
— pick at most one per build. The source compiles unchanged on either
backend; the difference is which GPU dispatch tables llama.cpp links in.
On NVIDIA, CUDA is typically 2-5× faster than Vulkan for inference
thanks to cuBLAS/cuDNN — particularly for prompt prefill (matmul-heavy)
and at larger batch sizes.

Build prerequisites:

- CUDA Toolkit 12.x (with nvcc + matching MSVC toolchain on Windows)
- Visual Studio 2022 BuildTools (cl 14.44, per project memory)
- NVIDIA driver ≥ 535 (matches CUDA 12.x)
- `FERAL_CUDA_ARCHS` env var set to your card's SM version
  (Turing=75, Ampere=86, Ada=89, Hopper=90). Trim the list to
  what you own to cut compile time.

The launcher `run-app-ui-cuda.bat` wires all of this; see
`scripts/LAUNCHERS.md` for the exact recipe. **Untested on this dev box**
(RX 580 has no CUDA toolkit) — verification needs an NVIDIA box with
the prerequisites installed.

## Context pool cap (added 2026-06-28)

`effective_pool_cap(gpu_active)` in `inference.rs::backend` sets the max
number of pooled KV-cache contexts the model holds warm for overlapping
generations. Defaults are:

| Build | Default cap | Override knob |
|---|---|---|
| GPU (cuda / vulkan / metal) | **1** | `FERAL_MAX_LOCAL_CONTEXTS=N` |
| CPU-only | 2 | `FERAL_MAX_LOCAL_CONTEXTS=N` |

**Why 1 on GPU:** each pooled context allocates its own full KV cache in
VRAM. On RX 580 (8 GB) + Qwen3.5-4B-Q6_K at 8K ctx: model ~3.5 GB +
first KV ~3.4 GB = ~6.7 GB used; a second KV (~3.4 GB) overflows and
llama.cpp returns `create context: null reference from llama.cpp` mid-
generation. There is no GPU→CPU fallback for *additional* contexts (the
model is already loaded with full GPU offload; switching backends means
reloading everything). Serializing generations through one context is the
safe default.

**Override:** users with cards that have VRAM headroom for parallel
decodes (e.g. RTX 4090 24 GB + Qwen3.5-4B) can opt back into 2 by setting
`FERAL_MAX_LOCAL_CONTEXTS=2`. The override always wins, even on small
cards — power users know their hardware.

The startup log line records the chosen cap:

```
model loaded (context pool ready, per-context KV prefix reuse)
  ...
  max_contexts=1
```

Plus a separate info line when the GPU auto-cap kicks in:

```
GPU offload active — capping context pool at 1 (each context = full KV cache in VRAM;
set FERAL_MAX_LOCAL_CONTEXTS=N to override for cards with enough VRAM for parallel decodes)
```

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
