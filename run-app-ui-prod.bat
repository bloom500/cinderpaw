@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"
set "FERAL_RSI_PASSIVE=false"
set "FERAL_EMBED_GPU_LAYERS=0"
set "FERAL_EMBED_CHUNK=32"
REM Production bench: NO FERAL_FRACTAL_BENCH_MAX_LEAVES ? we want the full
REM 2697-leaf rebuild. Tree-builder's MAX_CLUSTER_ITEMS_CHARS cap keeps each
REM cluster-summary request inside the provider's context window.
echo [launcher] PRODUCTION: full corpus (no MAX_LEAVES), MiniMax cloud router via wrapper, RSI off
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
