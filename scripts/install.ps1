# Cinderpaw installer for Windows. The one command from cinderpaw.dev/app:
#
#   irm https://raw.githubusercontent.com/bloom500/cinderpaw/main/scripts/install.ps1 | iex
#
# Downloads the prebuilt Cinderpaw into %USERPROFILE%\.cinderpaw\bin, checks its
# SHA-256, then `cinderpaw self-install` sets up start-at-login, PATH and the
# Start Menu shortcut, starts it and opens the browser. No admin rights.
# Running it again updates Cinderpaw and changes nothing else.
#
# This runs through `iex`, inside the user's own window. So: no `exit` anywhere
# (it would close that window and the message with it), and no param() block
# (iex ignores it). Knobs are env vars: CINDERPAW_DOWNLOAD_BASE, CINDERPAW_VERSION,
# CINDERPAW_HOME.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # the PS 5.1 progress bar makes downloads 10x slower
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

  $repo = 'bloom500/cinderpaw'
  $offline = "I couldn't download Cinderpaw. Check your internet and run the same command again."
  $unsupported = "Cinderpaw doesn't run on this computer yet. It needs Windows 10+, macOS 12+ or a 64-bit Linux."
  $say = { param($t) Write-Host $t -ForegroundColor Yellow }

  # x64 only; Windows 11 on ARM runs x64 programs, Windows 10 on ARM does not.
  $arch = $env:PROCESSOR_ARCHITEW6432; if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  $ver = [Environment]::OSVersion.Version
  $ok = ($arch -eq 'AMD64' -and $ver.Major -ge 10) -or ($arch -eq 'ARM64' -and $ver.Build -ge 22000)
  if (-not $ok) { & $say $unsupported; return }

  $asset = 'cinderpaw-windows-x64.zip'
  $root = if ($env:CINDERPAW_HOME) { $env:CINDERPAW_HOME } else { Join-Path $env:USERPROFILE '.cinderpaw' }
  $bin = Join-Path $root 'bin'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('cinderpaw-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $tmp, $bin | Out-Null

  Write-Host -NoNewline 'Downloading Cinderpaw... '
  try {
    if ($env:CINDERPAW_DOWNLOAD_BASE) { $base = $env:CINDERPAW_DOWNLOAD_BASE }
    else {
      $tag = $env:CINDERPAW_VERSION
      if (-not $tag) {
        # The desktop owns "latest", so list and pick the newest CLI release.
        $tag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=30" |
          ForEach-Object { $_ } | Where-Object { $_.tag_name -like 'cinderpaw-agent-v*' } |
          Select-Object -First 1).tag_name
      }
      if (-not $tag) { throw 'no release' }
      $base = "https://github.com/$repo/releases/download/$tag"
    }
    $zip = Join-Path $tmp $asset
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $zip
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  } catch {
    Write-Host ''; & $say $offline
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; return
  }

  $want = $null
  foreach ($line in ($sums -split "`n")) {
    if ($line -match "^\s*([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($asset))\s*$") { $want = $Matches[1]; break }
  }
  $got = (Get-FileHash -Algorithm SHA256 $zip).Hash
  if (-not $want -or $want.ToUpper() -ne $got.ToUpper()) {
    Write-Host ''; & $say 'The download was damaged. Run the same command again.'
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; return
  }

  $x = Join-Path $tmp 'x'
  Expand-Archive -Path $zip -DestinationPath $x -Force
  # A running .exe cannot be overwritten, but it can be renamed. Park the old
  # one as .old (deleted on the next run, once nothing holds it).
  Get-ChildItem $bin -Filter '*.old' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  foreach ($f in 'cinderpaw.exe', 'cinderpaw-agent.exe', 'cinderpaw-tui.exe') {
    $dst = Join-Path $bin $f
    if (Test-Path $dst) { Move-Item -Force $dst ("$dst." + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.old') }
    Copy-Item -Force (Join-Path $x $f) $dst
  }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Write-Host ([char]0x2713)

  & (Join-Path $bin 'cinderpaw.exe') self-install
}
