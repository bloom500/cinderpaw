# Windows Vulkan Build (RX 580, llama.cpp)

**Status:** Reference — recipe that finally worked, after 3 failed attempts.
**Date:** 2026-06-22
**Branch / worktree:** `feat/rsi-fractal-memory` @ `D:\FeralLocalAI\.worktrees\wt-29286b1b`

## TL;DR

The combination that builds a working llama.cpp Vulkan backend for the RX 580
on Windows 11:

1. **MSVC `cl.exe` 14.44 (VS 2022, NOT v18 preview)**
2. **`CMAKE_GENERATOR=Ninja`**
3. **`CARGO_TARGET_DIR=D:\fb`**

Skipping any of the three leads to one of two known failures: `VCEnd`
(error in the link step because the LLVM/Clang ANGLE includes shadow
something), or `C1083 MAX_PATH` (cargo's nested `target/debug` blows past
the 260-char Windows path limit when the build root is under
`C:\Users\...\AppData\Local`).

## The exact recipe

```powershell
# 1. From a fresh shell: pull VS 2022's vcvars64 into the env.
#    The cl.exe that ships with the v18 preview (cl 19.x) trips an
#    internal compiler error on llama.cpp's ggml-cuda build.
& "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
#    → confirm with: `cl 2>&1 | findstr Version` → "Microsoft (R) C/C++ Optimizing Compiler Version 19.44..."

# 2. Point CMake at Ninja (avoids the MSBuild generator's Vulkan
#    shimming bug that surfaces as VCEnd in the link step).
$env:CMAKE_GENERATOR = "Ninja"

# 3. Build outside the long path. Cargo's default target/ under the
#    worktree is fine for Rust, but the *C* build (llama.cpp) goes deep
#    enough to hit C1083. D:\fb is a flat short path just for this.
$env:CARGO_TARGET_DIR = "D:\fb"

# 4. Build as usual.
cargo build --release --features vulkan
```

## What the wrong toolchain looks like (for next time we hit it)

| Toolchain             | Symptom                              |
|-----------------------|--------------------------------------|
| cl.exe 19.40+ (v18)   | ICE in the ggml-cuda shim, link fails |
| MSBuild generator     | `VCEnd` error on the Vulkan link      |
| Default `target/`     | `C1083: ... : MAX_PATH`               |

## Why it matters for Feral

The Feral sidecar uses llama.cpp for embedding (`bge-small`) and for chat
(VibeThinker-3B). The embed path is the cold-start killer for the Fractal
Memory rebuild — see `project_fractal_bench_blockers.md`. A working
Vulkan build is required for any non-CPU embed experiment, but the RX 580
crashes at *model load* time (see `project_local_models_gpu.md` →
`STATUS_ACCESS_VIOLATION`). Until the GPU path is stable, the CPU
workaround is what runs in the dev environment.
