<#
.SYNOPSIS
  Make the machine look off while it keeps working.

.DESCRIPTION
  Written for the 30-hour TheAgentCompany run: the benchmark has to keep
  running overnight, but a lit monitor in a dark room is both wasted watts and
  a conversation with somebody's mother.

  What it actually does, so nobody expects more:

    * Turns the display off NOW. Any key or mouse movement brings it back.
    * Optionally shortens the display idle timeout, so it goes dark again on
      its own a minute after you walk away instead of after fifteen.

  What it CANNOT do, because no script can: the power LED, the case and
  keyboard LEDs, and the fans. Those are firmware or vendor software. The
  machine will look like one with its screen off, not like one that is off.

  It deliberately does NOT touch sleep or hibernate. Those are what would kill
  a long run, and on this machine they are already disabled.

.PARAMETER IdleMinutes
  Display idle timeout to set, in minutes. 0 leaves the current setting alone.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\lights-out.ps1
  powershell -ExecutionPolicy Bypass -File scripts\lights-out.ps1 -IdleMinutes 0
#>
param([int]$IdleMinutes = 1)

# Refuse to help if the machine could fall asleep under a running job: a dark
# screen and a suspended benchmark look identical from the doorway, and only
# one of them is what was asked for.
$standby = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE |
            Select-String "Current AC Power Setting Index") -replace '.*:\s*', ''
if ($standby -and [Convert]::ToInt32($standby, 16) -ne 0) {
    Write-Warning "Sleep is enabled (standby idle = $([Convert]::ToInt32($standby,16))s). A long run would be suspended. Fix with: powercfg /change standby-timeout-ac 0"
}

if ($IdleMinutes -gt 0) {
    powercfg /change monitor-timeout-ac $IdleMinutes
    Write-Host "Display goes dark after $IdleMinutes minute(s) idle."
}

Add-Type -Namespace Win -Name Power -MemberDefinition @'
[DllImport("user32.dll")]
public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);
'@

# HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2 = off.
[void][Win.Power]::SendMessage(0xffff, 0x0112, 0xF170, 2)
Write-Host "Display off. The machine keeps working; press any key to see it again."
