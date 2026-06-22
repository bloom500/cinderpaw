@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"
set "FERAL_RSI_PASSIVE=false"
set "FERAL_FRACTAL_BENCH_MAX_LEAVES=200"
set "FERAL_EMBED_GPU_LAYERS=0"
set "FERAL_EMBED_CHUNK=32"
echo [launcher] UI mode, NO env-bench, NO JSONL ? but bench cap=200 leaves so rebuild stays cheap
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
