/**
 * Cinderpaw's own browser profiles (one per browser: Chrome, Brave, Firefox...),
 * for when the agent opens a real browser from
 * a command because the built-in one failed (smoke test, 7 Nov: Chrome ran in
 * the background on Darius's own profile to take one screenshot, with his mail
 * signed in). Darius, the same day: a fallback that finishes the task is good,
 * but in its own space, tidied away at the end like a tab group. Chrome 136+
 * lets no program drive the person's default profile, and tab groups need an
 * extension, so the space is a profile of our own:
 *   - shell_exec runs a Chromium browser only with --user-data-dir (this one,
 *     named in its refusal), never on the person's profile;
 *   - the profile is kept between tasks, so a sign-in there is remembered;
 *   - every process on it is closed when the turn that used it ends.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cinderpawHome } from "../config.ts";

/** Where every browser's Cinderpaw profile lives; matched to close them. */
export function fallbackBrowserRoot(): string {
  return join(cinderpawHome(), "browser-fallback");
}

/** One profile per browser (Brave, Firefox... each keeps its own kind of
 *  data), made ready before it is named: Firefox wants the folder to exist. */
export function fallbackBrowserProfile(browser: string): string {
  const dir = join(fallbackBrowserRoot(), browser);
  try { mkdirSync(dir, { recursive: true }); } catch { /* the browser says why */ }
  return dir;
}

/** Chats whose current turn started a browser on the profile. */
const used = new Set<string>();

export function markFallbackBrowser(sessionId: string): void {
  used.add(sessionId);
}

/**
 * Close every process running on the profile, once the turn that used it ends.
 * Matched by the profile's path in the command line, so only our browser goes,
 * never one of the person's. ponytail: two chats driving it at once lose it
 * when the first ends; the next command opens it again.
 */
export function closeFallbackBrowser(sessionId: string): void {
  if (!used.delete(sessionId)) return;
  const dir = fallbackBrowserRoot();
  try {
    if (process.platform === "win32") {
      const ps =
        "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and " +
        `$_.CommandLine.Contains('${dir.replace(/'/g, "''")}') } | ` +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      spawn("pkill", ["-f", "--", dir], { stdio: "ignore" }).unref();
    }
  } catch {
    // A browser left open is a nuisance, never a reason to fail the turn.
  }
}
