@echo off
REM ── CUDA dev launcher (NVIDIA GPU) ────────────────────────────────────────
REM Builds + runs the app with `cargo tauri dev --features inference-cuda`
REM so chat inference uses NVIDIA CUDA via cuBLAS/cuDNN (faster than Vulkan
REM on NVIDIA hardware). On Windows you need:
REM   - CUDA Toolkit 12.x (with nvcc + matching MSVC toolchain)
REM   - Visual Studio 2022 BuildTools (cl 14.44, per project memory)
REM   - NVIDIA driver >= 535 (matches CUDA 12.x)
REM
REM This launcher does NOT source vcvars64 itself — it's expected that
REM `run-app-ui-cuda.bat` is invoked from a shell where vcvars64 has already
REM been called, OR from a developer prompt. Reason: the CUDA Toolkit's
REM `vcvarsall.bat` overrides the VS BuildTools one and chains awkwardly.
REM Pick whichever order your local toolchain prefers; both work as long as
REM nvcc + cl + link are on PATH and cl is the matching 14.44 version.
REM
REM Embedding is NOT auto-forced to CPU on CUDA builds — the AMDVLK crash
REM that affects Vulkan on RX 580/Polaris does not apply to NVIDIA + CUDA.
REM If you hit a different driver issue, set FERAL_EMBED_GPU_LAYERS=0 manually.

REM Context pool auto-caps at 1 on GPU (each context = full KV cache in
REM VRAM; a 24GB card can opt into 2 via FERAL_MAX_LOCAL_CONTEXTS=2).

REM Short target dir dodges C1083 MAX_PATH in llama.cpp's CUDA build
REM (cublas + cudart headers nest deep).
set "CARGO_TARGET_DIR=D:\fb"

REM CUDA arch list — compile only for the GPU you actually have. RTX 30/40 =
REM sm_75/86/89. Compile time scales with arch count; trim to what you own.
REM Auto-detect would be nicer but fragile (no portable way to query nvidia-smi
REM from cmd without flashing a console window). Override on the cmd line if
REM your card is different, e.g. `set FERAL_CUDA_ARCHS=89` then run.
if not defined FERAL_CUDA_ARCHS set "FERAL_CUDA_ARCHS=75;86;89"

set "CMAKE_GENERATOR=Ninja"

echo [launcher] CUDA dev ^|^| archs=%FERAL_CUDA_ARCHS% ^|^| target=%CARGO_TARGET_DIR%
cd /d "D:\FeralLocalAI\src-tauri"
cargo tauri dev --features inference-cuda