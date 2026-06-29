@echo off
REM ── Dream Cycle test launcher (current branch: feat/reactive-pixel-tree) ──
REM Builds + runs the app from D:\FeralLocalAI (NOT the old wt-29286b1b worktree).
REM MSVC env via VS2022 BuildTools (cl 14.44, per project memory — NOT VS18 preview).
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
REM Force CMake to use Ninja + the 14.44 cl from vcvars on PATH. Without a
REM REACHABLE ninja.exe, CMake falls back to its newest-VS generator (VS18
REM preview) → llama.cpp objects reference STL symbols the 14.44 link libs
REM lack → LNK2001 __std_regex_transform_primary_char. The ninja that ships
REM with VS2022 BuildTools lives under Common7\IDE\, NOT the VC root.
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"

REM ── Dream Cycle ON, tuned SHORT so you can watch a full cycle in ~1 min ──
set "FERAL_RSI_PASSIVE=true"
set "FERAL_RSI_IDLE_MS=15000"        REM dream after 15s idle (default 3 min)
set "FERAL_RSI_COOLDOWN_MS=30000"    REM 30s between episodes (default 10 min)
set "FERAL_RSI_POLL_MS=5000"         REM evaluate triggers every 5s (default 30s)
set "FERAL_RSI_EPISODE_MS=60000"     REM hard 1-min wall-clock cap per episode (default 8 min)
set "FERAL_RSI_ERROR_THRESHOLD=2"    REM 2 errors in window wakes a dream (default 3)
set "FERAL_RSI_MAX_COST_USD=0"       REM local-only; cloud refused unless ALLOW_CLOUD
REM Telemetry lands at %USERPROFILE%\.feral\rsi\dream.jsonl

set "FERAL_FRACTAL_BENCH_MAX_LEAVES=200"
set "FERAL_EMBED_GPU_LAYERS=0"
set "FERAL_EMBED_CHUNK=32"

echo [launcher] Dream Cycle ON ^| idle=15s cooldown=30s poll=5s episode-cap=60s ^| local-only $0
cd /d "D:\FeralLocalAI\src-tauri"
cargo tauri dev
