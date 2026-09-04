# Live view of an ARC-AGI-3 run, for PowerShell — the shell this machine
# actually opens by default. One line per game, refreshed every 5s.
#
#   pwsh -File "D:\Cinderpaw Agent\runs-arc\watch.ps1"
#   pwsh -File ".\runs-arc\watch.ps1" -Run clean-20260827-2238 -Arm B
#
# Reads the logs the games are already writing. It starts nothing and stops
# nothing, so it is safe to open and close whenever.
param(
  [string]$Run = "",
  [string]$Arm = "B"
)
$root = "D:\Cinderpaw Agent"
if ($Run -eq "") { $Run = (Get-Content "$root\runs-arc\CURRENT_AB" -Raw).Trim() }
$dir = Join-Path $root "runs-arc\$Run\$Arm"
if (-not (Test-Path $dir)) { Write-Host "no such run: $dir"; exit 1 }

while ($true) {
  $rows = @()
  $total = 0; $done = 0; $crashed = 0; $spend = 0.0
  foreach ($f in Get-ChildItem -Path $dir -Filter *.log | Sort-Object Name) {
    $lines = Get-Content $f.FullName -ErrorAction SilentlyContinue
    # Press lines look like "   12  ACTION6:41,4   NOT_FINISHED  levels=0/9"
    $last = $lines | Where-Object { $_ -match '^\s+\d+\s\s' } | Select-Object -Last 1
    $n = 0; $act = "-"; $state = "starting"; $lv = "-"
    if ($last) {
      $p = ($last -split '\s+') | Where-Object { $_ -ne "" }
      $n = [int]$p[0]; $act = $p[1]; $state = $p[2]
      if ($last -match 'levels=(\d+/\d+)') { $lv = $Matches[1] }
    }
    $note = ""
    if ($lines -match '^result      ') {
      $done++
      $s = $lines | Where-Object { $_ -match '^spend       \$' } | Select-Object -First 1
      if ($s -match '\$([0-9.]+)') { $spend += [double]$Matches[1]; $note = "done `$$($Matches[1])" }
    } elseif ($lines -match '^(error:|Bun v)') {
      $crashed++; $note = "CRASHED"
    }
    $total += $n
    $rows += [pscustomobject]@{
      GAME = $f.BaseName; PRESSES = $n; LEVELS = $lv; LAST = $act; STATE = $state; NOTE = $note
    }
  }
  Clear-Host
  Write-Host "ARC-AGI-3  $Run  arm $Arm   $(Get-Date -Format HH:mm:ss)"
  $rows | Format-Table -AutoSize | Out-String | Write-Host
  # AVO is the only external number on this benchmark: 6,624 actions over 25
  # games, ~265 each. Ours beside it, live, rather than as a surprise at the end.
  Write-Host ("presses {0}   (NVIDIA AVO used 6624 over 25 games, ~265 each)" -f $total)
  Write-Host ("finished {0}/25   crashed {1}   spend `${2:N4}" -f $done, $crashed, $spend)
  Write-Host "`nctrl-c closes this view; the run keeps going."
  Start-Sleep -Seconds 5
}
