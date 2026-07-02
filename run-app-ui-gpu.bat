@echo off
REM ── GPU dev launcher (Vulkan backend) ──────────────────────────────────────
REM Builds + runs the app with `cargo tauri dev --features inference-vulkan`
REM so chat inference uses the GPU. Same Windows toolchain recipe as
REM run-dream-test.bat (cl 14.44, Ninja, short CARGO_TARGET_DIR — see
REM docs/agents-memory/reference_windows_vulkan_build.md).
REM
REM On RX 580 / other Polaris-era AMD cards, embedding (bge-small) is
REM auto-forced to CPU at startup by the host because of a known
REM llama.cpp × AMDVLK driver crash — see project_local_models_gpu.md.
REM Chat (VibeThinker-3B, ~1.8 GB) DOES use the GPU fine.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"

REM Short target dir dodges C1083 MAX_PATH in llama.cpp's nested
REM vulkan-shaders-gen cmake build. Required for Vulkan — CPU builds
REM can omit it.
set "CARGO_TARGET_DIR=D:\fb"

REM (Embed layers are NOT preset here — the host auto-forces CPU on
REM  AMD GPUs at startup. To override manually, set FERAL_EMBED_GPU_LAYERS.)

REM Context pool auto-caps at 1 on GPU (each context = full KV cache in
REM VRAM; 2 contexts on 8GB cards explodes with "null reference" from
REM llama.cpp). Set FERAL_MAX_LOCAL_CONTEXTS=N to opt into more.

REM RX 580 + 4B thinking model: a chat generation and an RSI eval can
REM serialize on the single GPU context — give local calls 15 min instead
REM of the 5-min default before the total-deadline watchdog kills them.
set "FERAL_TOTAL_DEADLINE_MS=900000"

echo [launcher] GPU/Vulkan dev ^|^| default_gpu_layers=%FERAL_DEFAULT_GPU_LAYERS% ^|^| embed auto-CPU on AMD
cd /d "D:\FeralLocalAI\src-tauri"
cargo tauri dev --features inference-vulkan