#requires -Version 5.1
<#
.SYNOPSIS
    Rebuild the Cinderpaw Agent sidecar after a code-RSI patch is applied.

.DESCRIPTION
    Faza 3 — Slice 2 ("closing the loop"): after `applyPatchLive`
    succeeds the Rust host invokes this script so the patched source
    becomes the running agent. The script:

      1. Resolves the repo root (defaults to $PSScriptRoot\.. — i.e. the
         directory that contains this script's parent).
      2. Verifies `bun` is on PATH. If it isn't, writes a clear message
         to stderr and exits 2 — the host treats exit 2 as
         "rebuild unavailable" (e.g. a user machine without the Bun
         toolchain installed), not as a fatal error.
      3. Runs `bun run build` in <RepoRoot>\CinderpawAgent. Any non-zero
         exit propagates as exit 1.
      4. Copies the freshly built binary
         (<RepoRoot>\CinderpawAgent\dist\cinderpaw-agent.exe) over the
         Tauri externalBin target
         (<RepoRoot>\src-tauri\binaries\cinderpaw-agent-<target-triple>).
         On Windows the triple is `x86_64-pc-windows-msvc.exe`.
      5. Exits 0 with the absolute path of the binary it wrote.

    The script is intentionally Windows-first: Cinderpaw is shipped as a
    Windows desktop app, and the patch-applied-on-source → agent-becomes-
    patched loop is a developer-machine story (user machines are
    explicitly deferred per the Faza 3 spec).

.PARAMETER RepoRoot
    The repository root. Defaults to the parent of the directory that
    contains this script (i.e. `$PSScriptRoot\..`).

.EXAMPLE
    pwsh -File scripts/rsi-rebuild-sidecar.ps1
    Runs with the default repo root inferred from the script location.

.EXAMPLE
    pwsh -File scripts/rsi-rebuild-sidecar.ps1 -RepoRoot D:\CinderpawLocalAI
    Runs against an explicit repo root.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

$cinderpawAgentDir = Join-Path $RepoRoot 'CinderpawAgent'
$distExe       = Join-Path $cinderpawAgentDir 'dist/cinderpaw-agent.exe'
$binariesDir   = Join-Path $RepoRoot 'src-tauri/binaries'
$targetExe     = Join-Path $binariesDir 'cinderpaw-agent-x86_64-pc-windows-msvc.exe'

function Write-Status {
    param([string]$Message)
    [Console]::Error.WriteLine("[rsi-rebuild-sidecar] $Message")
}

# 1. Toolchain check.
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    Write-Status "FATAL: 'bun' is not on PATH. Install Bun (https://bun.sh) on this dev machine and retry. The host treats this as 'rebuild unavailable' (exit 2)."
    exit 2
}

# 2. Sanity-check the repo layout. We deliberately fail loud here —
# a missing CinderpawAgent/ is a build-script bug, not a toolchain gap.
if (-not (Test-Path -LiteralPath $cinderpawAgentDir)) {
    Write-Status "FATAL: CinderpawAgent/ not found at $cinderpawAgentDir. Repo root looks wrong."
    exit 1
}

# 3. Run the build. Any non-zero exit is fatal.
# `bun run build` reads package.json from the current directory, so we
# must change into CinderpawAgent/ before invoking it. We save and restore
# the caller's location so a host that imports this script (rather
# than spawning a fresh pwsh) doesn't get its cwd stomped.
$originalCwd = (Get-Location).ProviderPath
try {
    Set-Location -LiteralPath $cinderpawAgentDir
    Write-Status "running: bun run build (cwd=$cinderpawAgentDir)"
    & bun run build
    if ($LASTEXITCODE -ne 0) {
        Write-Status "FATAL: 'bun run build' exited with status $LASTEXITCODE"
        exit 1
    }
} finally {
    Set-Location -LiteralPath $originalCwd
}

# 4. Copy the freshly built binary over the Tauri externalBin target.
if (-not (Test-Path -LiteralPath $distExe)) {
    Write-Status "FATAL: expected dist binary at $distExe after build, but it does not exist."
    exit 1
}
if (-not (Test-Path -LiteralPath $binariesDir)) {
    New-Item -ItemType Directory -LiteralPath $binariesDir -Force | Out-Null
}
Copy-Item -LiteralPath $distExe -Destination $targetExe -Force

# 5. Success.
Write-Output $targetExe
exit 0