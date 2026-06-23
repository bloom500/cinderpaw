@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"
REM RSI passive ON — engine autostarts at sidecar launch, runs continuously
REM in the background. Cost cap = $2 USD so the Starter Plan budget isn't blown.
set "FERAL_RSI_PASSIVE=true"
set "FERAL_RSI_MAX_COST_USD=2.00"
set "FERAL_FRACTAL_BENCH_MAX_LEAVES=200"
set "FERAL_EMBED_GPU_LAYERS=0"
set "FERAL_EMBED_CHUNK=32"
echo [launcher] UI mode, RSI passive ON with $2 cap, bench cap=200 leaves so rebuild stays cheap
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
