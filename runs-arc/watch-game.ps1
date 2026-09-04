# Watch one ARC-AGI-3 game as a picture, live.
#
#   pwsh -File "D:\Cinderpaw Agent\runs-arc\watch-game.ps1" -Game ls20-9607627b
#   ... -Run clean-20260827-2238 -Arm B -Fps 4
#
# Reads frames.jsonl, which the runner appends to as it plays: one line a press,
# the grid encoded as one hex character a cell. This starts nothing and stops
# nothing — close it whenever.
param(
  [Parameter(Mandatory=$true)][string]$Game,
  [string]$Run = "",
  [string]$Arm = "B",
  [int]$Fps = 3
)
$root = "D:\Cinderpaw Agent"
if ($Run -eq "") { $Run = (Get-Content "$root\runs-arc\CURRENT_AB" -Raw).Trim() }

# The runner prints the path it wrote; that is the tie between a game and its
# frames, so nothing here has to guess from timestamps.
$log = Join-Path $root "runs-arc\$Run\$Arm\$Game.log"
if (-not (Test-Path $log)) { Write-Host "no log for $Game in $Run/$Arm"; exit 1 }
$framesPath = ""
$m = Select-String -Path $log -Pattern '^frames      (.+)$' | Select-Object -Last 1
if ($m) { $framesPath = $m.Matches[0].Groups[1].Value.Trim() }
if ($framesPath -eq "") {
  # Still playing: the path is not printed until the end, so derive it from the
  # manifest line, which is printed at the start.
  $m = Select-String -Path $log -Pattern '^manifest    (.+)run-manifest\.json$' | Select-Object -Last 1
  if ($m) { $framesPath = Join-Path $m.Matches[0].Groups[1].Value.Trim() "frames.jsonl" }
}
if ($framesPath -eq "") {
  # Still playing. Neither line is in the log yet: both are printed when the
  # game ENDS. The launcher writes _frames_map.txt instead — game id to the
  # runs/arc-<epoch> directory the runner opened for it.
  $map = Join-Path $root "runs-arc\$Run\_frames_map.txt"
  if (Test-Path $map) {
    foreach ($line in Get-Content $map) {
      $p = $line -split '\s+'
      if ($p[0] -eq $Game) { $framesPath = Join-Path $root "CinderpawAgent\runs\$($p[1])\frames.jsonl" }
    }
  }
}
if ($framesPath -eq "" -or -not (Test-Path $framesPath)) {
  # A run started before frames existed, or one that has not written its first
  # press yet. Say which, rather than showing an empty screen.
  Write-Host "no frames for $Game yet."
  Write-Host "(runs started before the frame writer landed have none at all — they are logs only.)"
  exit 1
}

# 16 ARC colours -> the xterm-256 blocks closest to them. Two characters a cell
# so the board is square on a terminal, whose cells are about half as wide as
# they are tall.
$palette = @(16,21,196,46,226,244,201,208,51,88,231,33,214,129,40,124)
$esc = [char]27
while ($true) {
  $last = Get-Content $framesPath -Tail 1 -ErrorAction SilentlyContinue
  if ($last) {
    $f = $last | ConvertFrom-Json
    $sb = New-Object System.Text.StringBuilder
    foreach ($row in ($f.grid -split "`n")) {
      foreach ($ch in $row.ToCharArray()) {
        $c = $palette[[Convert]::ToInt32($ch, 16)]
        [void]$sb.Append("$esc[48;5;${c}m  ")
      }
      [void]$sb.Append("$esc[0m`n")
    }
    Clear-Host
    Write-Host "$Game   press $($f.n)   $($f.action)   $($f.state)   levels $($f.levels)   $([int]($f.atMs/1000))s"
    Write-Host $sb.ToString()
    Write-Host "ctrl-c closes this view; the game keeps playing."
  }
  Start-Sleep -Milliseconds ([int](1000 / [Math]::Max(1, $Fps)))
}
