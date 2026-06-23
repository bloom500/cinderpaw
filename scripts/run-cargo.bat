@echo off
REM Build/test helper for cargo on Windows (vcvars + cmake 3.31 + Ninja).
REM Usage: scripts\run-cargo-tests.bat [cargo-args]
REM
REM The Windows MSVC llama.cpp build needs:
REM   - VS 2022 vcvars64.bat (cl 14.44 — NOT v18 preview)
REM   - cmake 3.31 (cmake crate 0.1.58 has a known bug with cmake 4.x)
REM   - CMAKE_GENERATOR=Ninja
REM   - CARGO_TARGET_DIR on a short path (D:\fb_prB) to dodge MAX_PATH C1083
set CMAKE_BIN=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin
set NINJA_BIN=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja
set PATH=%CMAKE_BIN%;%NINJA_BIN%;%PATH%
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set CMAKE_GENERATOR=Ninja
set CMAKE_MAKE_PROGRAM=ninja.exe
set CARGO_TARGET_DIR=D:\fb_prB
cd /d D:\FeralLocalAI\.worktrees\wt-29286b1b\src-tauri
cargo %*