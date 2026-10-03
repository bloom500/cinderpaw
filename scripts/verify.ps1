<#
.SYNOPSIS
  The verification gate, runnable on Windows without bash.

.DESCRIPTION
  A twin of scripts/verify.sh. It exists because verify.sh needs bash, and
  bash is not present on every Windows dev box — which meant the one gate
  AGENTS.md requires before "done" could not actually be run there, and the
  steps were being executed by hand instead. A gate nobody can run is not a
  gate; the numbers it would have produced were being taken on trust.

  Keep this in step with verify.sh. If the two ever disagree about what
  "green" means, that is the bug — not a preference.

  Rust note: all three cargo packages are tested: `cinderpaw` is the Tauri
  host (src-tauri), `cinderpaw-core` is the engine, and `cinderpaw-cli` is
  the command-line interface.

  Running it in a FRESH worktree: install first (`bun install` in both
  CinderpawAgent and frontend-react). Even then a fresh resolve can pull
  different type-only dependencies than an established tree and turn the
  typecheck steps red for reasons that have nothing to do with the code —
  confirm any typecheck failure against the main working tree before
  believing it.

.EXAMPLE
  pwsh -File scripts/verify.ps1

.EXAMPLE
  pwsh -File scripts/verify.ps1 -SkipRust -SkipTui
#>

[CmdletBinding()]
param(
  # Skip the slow Rust steps for a quick TS/Go-only pass.
  [switch]$SkipRust,
  # Skip the Go TUI steps when the Go toolchain is absent.
  [switch]$SkipTui
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$script:Failures = @()

function Invoke-Step {
  param(
    [Parameter(Mandatory)][string]$Label,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][scriptblock]$Action
  )
  Write-Host ""
  Write-Host "==> $Label" -ForegroundColor Cyan
  Push-Location $WorkingDirectory
  try {
    & $Action
    # Native tools report failure through $LASTEXITCODE, not exceptions, so a
    # non-zero exit here would otherwise sail past as success.
    if ($LASTEXITCODE -ne 0) {
      throw "$Label failed (exit $LASTEXITCODE)"
    }
  }
  catch {
    $script:Failures += $Label
    Write-Host "    FAILED: $($_.Exception.Message)" -ForegroundColor Red
  }
  finally {
    Pop-Location
  }
}

$agent = Join-Path $Root 'CinderpawAgent'
$react = Join-Path $Root 'frontend-react'
$web = Join-Path $Root 'web-app'
$tui = Join-Path $Root 'tui'

Invoke-Step 'CinderpawAgent tests'     $agent { bun test --timeout 20000 }
Invoke-Step 'CinderpawAgent typecheck' $agent { bunx tsc --noEmit }
Invoke-Step 'React tests'              $react { bunx vitest run --pool=threads --maxWorkers=1 }
Invoke-Step 'React typecheck'          $react { bunx tsc --noEmit }
Invoke-Step 'Web app dependencies'    $web { bun install --frozen-lockfile }
Invoke-Step 'Web app tests'           $web { bun test }
Invoke-Step 'Web app typecheck'       $web { bun run typecheck }
Invoke-Step 'Game export script tests' $Root { node --test src-tauri/scripts/build-game.test.mjs }

$godotExe = $env:CINDERPAW_GODOT
if (-not $godotExe) {
  $godotCommand = Get-Command godot -ErrorAction SilentlyContinue
  if ($godotCommand) { $godotExe = $godotCommand.Source }
}
if ($godotExe) {
  Invoke-Step 'Campfire game tests' $Root {
    & $godotExe --headless --path (Join-Path $Root 'games/ember') --import
    if ($LASTEXITCODE -ne 0) { throw "Godot import failed (exit $LASTEXITCODE)" }
    & $godotExe --headless --path (Join-Path $Root 'games/ember') -s res://tests/run_tests.gd
  }
}
else {
  Write-Host "`n==> Campfire game tests: skipped, Godot is not installed (set CINDERPAW_GODOT)" -ForegroundColor Yellow
}

if (-not $SkipRust) {
  # The Tauri host crate's build script needs the compiled sidecar to exist at
  # src-tauri/binaries/cinderpaw-agent-<triple>.exe — it is a gitignored build
  # artifact, so on a fresh clone or a fresh worktree it is absent and
  # `cargo check` dies with "resource path ... doesn't exist", which reads like
  # a code failure and is not one. Tauri runs this same script from
  # beforeDevCommand; the gate has to run it too or it only works on a machine
  # that has already run the app. It self-skips when the binary is current.
  Invoke-Step 'Sidecar build'          (Join-Path $Root 'src-tauri') { node scripts/build-sidecar.mjs }
  Invoke-Step 'Rust check'             $Root { cargo check }
  Invoke-Step 'Rust tests (host)'      $Root { cargo test -p cinderpaw }
  Invoke-Step 'Rust tests (core)'      $Root { cargo test -p cinderpaw-core }
  Invoke-Step 'Rust tests (CLI)'       $Root { cargo test -p cinderpaw-cli }
}
else {
  Write-Host "`n==> Rust steps SKIPPED (-SkipRust)" -ForegroundColor Yellow
}

if (-not $SkipTui) {
  Invoke-Step 'TUI tests'              $tui { go test ./... }
  Invoke-Step 'TUI build'              $tui { go build ./... }
}
else {
  Write-Host "`n==> TUI steps SKIPPED (-SkipTui)" -ForegroundColor Yellow
}

Write-Host ""
if ($script:Failures.Count -gt 0) {
  Write-Host "Verification FAILED (" -NoNewline -ForegroundColor Red
  Write-Host "$($script:Failures.Count) step(s): $($script:Failures -join ', ')" -NoNewline -ForegroundColor Red
  Write-Host ")" -ForegroundColor Red
  # Every step runs even after one fails, so a single run reports the whole
  # picture instead of stopping at the first red and hiding the rest.
  exit 1
}

Write-Host "Verification passed." -ForegroundColor Green
exit 0
