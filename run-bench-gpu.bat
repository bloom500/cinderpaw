@echo off
REM Headless GPU benchmark launcher: VS2022 stable toolchain + Ninja generator
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"
REM Short target dir to dodge Windows MAX_PATH (260) in llama.cpp's nested vulkan-shaders-gen cmake build
set "CARGO_TARGET_DIR=D:\fb"
set "FERAL_RUN_FRACTAL_BENCH=1"
set "FERAL_FRACTAL_BENCH_COUNT=12"
set "FERAL_EMBED_GPU_LAYERS=999"
echo [launcher] cl: & where cl
echo [launcher] ninja: & where ninja
echo [launcher] CMAKE_GENERATOR=%CMAKE_GENERATOR%
cd /d "D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri"
cargo tauri dev --features inference-vulkan
