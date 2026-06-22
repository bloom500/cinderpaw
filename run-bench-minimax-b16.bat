@echo off
REM ===========================================================================
REM  Fractal Memory Search bench — BRANCH=16 sweep, full 2700-leaf corpus.
REM
REM  Goal: answer "is recall@10 bottlenecked by tree topology (too few
REM  top-level clusters) or by the embedding (bge-small 384d)?".
REM
REM  Baseline to beat (branch=8, 2700 leaves, seed=1, k=10, n=12):
REM      fractal recall@10 = 0.417   p99 = 32ms   SHIP
REM      fts     recall@10 = 0.083   p99 = 100ms
REM  A material jump (>0.50) => topology was the limiter; freeze a JSONL and
REM  publish. Flat (~0.40) => embedding is the ceiling; bge-large is next.
REM
REM  The branch=8 tree + report are backed up at:
REM      %USERPROFILE%\.feral\agent\fractal-tree.branch8.bak.json
REM      %USERPROFILE%\.feral\agent\fractal-bench-report.branch8.bak.json
REM ===========================================================================
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"

REM --- Force a fresh tree build: rebuildIfStale() is a no-op while the old
REM     branch=8 tree still covers all 2700 leaves, so delete it first. ---
if exist "%USERPROFILE%\.feral\agent\fractal-tree.json" del /q "%USERPROFILE%\.feral\agent\fractal-tree.json"

set "FERAL_TREE_BRANCH=16"
set "FERAL_RUN_FRACTAL_BENCH=1"
set "FERAL_FRACTAL_BENCH_COUNT=12"
set "FERAL_FRACTAL_BENCH_SEED=1"
REM  NO FERAL_FRACTAL_BENCH_MAX_LEAVES => full 2700-leaf corpus (same as the SHIP run).
set "FERAL_EMBED_GPU_LAYERS=0"
set "FERAL_RSI_PASSIVE=false"
set "FERAL_EMBED_CHUNK=32"
echo [launcher] BRANCH=16, full corpus, CPU embed, MINIMAX M3 summaries, RSI off
echo [launcher] watch the sidecar log for: fractal-bench: n=12 k=10 ... verdict=...
echo [launcher] new report -> %USERPROFILE%\.feral\agent\fractal-bench-report.json
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev
