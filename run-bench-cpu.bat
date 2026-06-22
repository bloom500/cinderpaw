@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"
set "FERAL_RUN_FRACTAL_BENCH=1"
set "FERAL_FRACTAL_BENCH_COUNT=12"
set "FERAL_FRACTAL_BENCH_MAX_LEAVES=200"
set "FERAL_EMBED_GPU_LAYERS=0"
set "FERAL_RSI_PASSIVE=false"
set "FERAL_EMBED_CHUNK=32"
echo [launcher] CPU, RSI off, embed chunk 32, BRIDGE FIELD FIX
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
