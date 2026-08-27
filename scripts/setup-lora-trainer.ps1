# Set up (or register) a LoRA trainer for Feral's L2 pipeline.
# Contract: docs/LORA_TRAINER.md.
#
# Two modes:
#   .\setup-lora-trainer.ps1                       -> INSTALL the bundled
#       NVIDIA trainer into <profile>\lora-trainer (venv + CUDA torch +
#       unsloth/peft + llama.cpp convert scripts) and register it.
#   .\setup-lora-trainer.ps1 -TrainerBin <path>    -> register an EXTERNAL
#       trainer you built yourself (probe --version, persist env var).
[CmdletBinding()]
param(
    [string]$TrainerBin
)
$ErrorActionPreference = 'Stop'

# ---- where the profile dir lives --------------------------------------------
# Mirrors tui/api/home.go, CinderpawAgent/src/config.ts and
# crates/cinderpaw-core/src/paths.rs (the rename from .feral to .cinderpaw).
# The ".feral" literal must never be CREATED here: on a migrated machine an
# unmarked ~/.feral makes the Rust host refuse to boot ("both exist, and the
# older one is not marked as migrated").
function Get-AppHome {
    $override = $env:CINDERPAW_HOME
    if (-not $override) { $override = $env:CINDERPAW_HOME }
    if ($override) { return $override }
    $modern = Join-Path $env:USERPROFILE '.cinderpaw'
    $legacy = Join-Path $env:USERPROFILE '.feral'
    if (Test-Path -LiteralPath $modern -PathType Container) { return $modern }
    # A pre-migration install: the old dir is where this machine's state is,
    # so installing next to it is correct - reading/creating it is not.
    if (Test-Path -LiteralPath $legacy -PathType Container) { return $legacy }
    return $modern
}

function Register-Trainer([string]$bin) {
    Write-Host "[setup-lora-trainer] probing: $bin --version"
    $proc = Start-Process -FilePath $bin -ArgumentList '--version' -NoNewWindow -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        Write-Error "probe failed: '$bin --version' exited $($proc.ExitCode). The trainer must answer --version with exit 0 (see docs/LORA_TRAINER.md)."
        exit 1
    }
    [Environment]::SetEnvironmentVariable('CINDERPAW_LORA_TRAINER_BIN', $bin, 'User')
    Write-Host "[setup-lora-trainer] OK - CINDERPAW_LORA_TRAINER_BIN set (user scope) to:"
    Write-Host "  $bin"
    Write-Host "Restart Feral (and any open terminals) to pick it up."
}

# ---- external-binary mode (original behavior) -------------------------------
if ($TrainerBin) {
    if (-not (Test-Path -LiteralPath $TrainerBin)) {
        Write-Error "trainer binary not found: $TrainerBin"
        exit 1
    }
    Register-Trainer (Resolve-Path -LiteralPath $TrainerBin).Path
    exit 0
}

# ---- install mode: bundled NVIDIA trainer -----------------------------------
Write-Host "[setup-lora-trainer] installing the bundled trainer (NVIDIA/CUDA)"

if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Write-Warning "nvidia-smi not found - no NVIDIA GPU/driver detected. Training will fall back to CPU and be impractically slow. Continuing anyway."
}

# Python 3.10-3.12 (torch/unsloth wheel coverage).
$python = $null
foreach ($cand in @(@('py', '-3.12'), @('py', '-3.11'), @('py', '-3.10'), @('python'))) {
    try {
        $probeArgs = @($cand | Select-Object -Skip 1) + '--version'
        $v = & $cand[0] @probeArgs 2>$null
        if ($v -match 'Python 3\.(1[0-2])\.') { $python = $cand; break }
    } catch {}
}
if (-not $python) {
    Write-Error "Python 3.10-3.12 not found. Install it from https://www.python.org/downloads/ (check 'py launcher') and re-run."
    exit 1
}
Write-Host "[setup-lora-trainer] python: $($python -join ' ')"

$dir = Join-Path (Get-AppHome) 'lora-trainer'
New-Item -ItemType Directory -Force $dir | Out-Null
$venv = Join-Path $dir 'venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $venvPy)) {
    Write-Host "[setup-lora-trainer] creating venv: $venv"
    $venvArgs = @($python | Select-Object -Skip 1) + @('-m', 'venv', $venv)
    & $python[0] @venvArgs
}

Write-Host "[setup-lora-trainer] installing packages (several GB, one-time)..."
& $venvPy -m pip install --upgrade pip --quiet
# CUDA torch first: the default PyPI wheel on Windows is CPU-only.
& $venvPy -m pip install torch --index-url https://download.pytorch.org/whl/cu124
& $venvPy -m pip install transformers peft datasets accelerate bitsandbytes gguf sentencepiece protobuf
# unsloth is the fast path but its Windows install (triton) is flaky -
# best-effort: the trainer falls back to transformers+peft without it.
& $venvPy -m pip install unsloth
if ($LASTEXITCODE -ne 0) {
    Write-Warning "unsloth install failed - trainer will use the transformers+peft fallback (slower, same output)."
}

# llama.cpp checkout for convert_lora_to_gguf.py (+ its bundled gguf-py).
$llamacpp = Join-Path $dir 'llama.cpp'
if (-not (Test-Path (Join-Path $llamacpp 'convert_lora_to_gguf.py'))) {
    Write-Host "[setup-lora-trainer] fetching llama.cpp convert scripts..."
    git clone --depth 1 https://github.com/ggml-org/llama.cpp $llamacpp
    if ($LASTEXITCODE -ne 0) {
        Write-Error "git clone of llama.cpp failed - git + network are required for the GGUF conversion step."
        exit 1
    }
}

Copy-Item (Join-Path $PSScriptRoot 'lora-trainer\feral_lora_trainer.py') $dir -Force

$launcher = Join-Path $dir 'feral-lora-trainer.cmd'
Set-Content -Path $launcher -Value "@echo off`r`n`"$venvPy`" `"$(Join-Path $dir 'feral_lora_trainer.py')`" %*" -Encoding ascii

& $venvPy (Join-Path $dir 'feral_lora_trainer.py') self-test
if ($LASTEXITCODE -ne 0) {
    Write-Error "trainer self-test failed"
    exit 1
}

Register-Trainer $launcher
Write-Host ""
Write-Host "NOTE: training resolves the HF base model from the GGUF's metadata."
Write-Host "If your GGUF lacks provenance metadata, set CINDERPAW_LORA_HF_BASE to the"
Write-Host "HF repo id it was converted from (e.g. Qwen/Qwen2.5-7B-Instruct)."
