/**
 * `done_when` — mechanical proof that a scheduled task actually got done.
 *
 * Until now the only signal that a job succeeded was the agent's own closing
 * paragraph. That is the weakest evidence in the system: a model that misreads
 * a tool result as prose, or loses the thread across a compaction, produces a
 * confident "done — I've updated the report and pushed it" for work it never
 * finished. Nothing downstream could tell the difference.
 *
 * The walk-away bench already settled the principle for measurement — its
 * checks are deliberately mechanical, "a file exists and contains X, a command
 * exits 0", *because a pass/fail an LLM judges is a pass/fail you cannot
 * trust*. The runtime had no equivalent. This is it.
 *
 * A `done_when` is optional. Declared, it is the authority: the run is a
 * success only if the assertion passes, whatever the agent claims.
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * An assertion about the world after the task ran.
 *
 *  - `file_exists`   — `path` is present.
 *  - `file_contains` — `path` is present and contains `value` (plain substring).
 *  - `command`       — `value` runs and exits 0.
 */
export interface DoneWhen {
  kind: "file_exists" | "file_contains" | "command";
  /** Target path for the file checks. Relative paths resolve against the workspace. */
  path?: string;
  /** Substring for `file_contains`; the command line for `command`. */
  value?: string;
  /** Cap for `command`. Default 60s. */
  timeoutMs?: number;
}

export interface DoneCheck {
  /** True when there was no assertion to run, or the assertion held. */
  passed: boolean;
  /** False when no `done_when` was declared — the run is unverified, not verified. */
  checked: boolean;
  /** One line for the digest. */
  detail: string;
}

/** No assertion declared: nothing to contradict the agent, and we say so. */
const UNCHECKED: DoneCheck = {
  passed: true,
  checked: false,
  detail: "no done_when declared — completion is the agent's own claim, unverified",
};

/** Parse a `done_when` off a stored job, tolerating absent or malformed values. */
export function parseDoneWhen(raw: unknown): DoneWhen | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "file_exists" && kind !== "file_contains" && kind !== "command") return null;
  const path = typeof o.path === "string" ? o.path : undefined;
  const value = typeof o.value === "string" ? o.value : undefined;
  const timeoutMs = typeof o.timeoutMs === "number" ? o.timeoutMs : undefined;
  // A check that cannot possibly run is worse than none: it would fail every
  // run forever and bury a job that is working fine.
  if ((kind === "file_exists" || kind === "file_contains") && !path) return null;
  if ((kind === "file_contains" || kind === "command") && !value) return null;
  return { kind, path, value, timeoutMs };
}

function within(root: string | null, path: string): string {
  return isAbsolute(path) ? path : resolve(root ?? process.cwd(), path);
}

/** Run `value` through the platform shell, returning its exit code. */
function runCommand(command: string, cwd: string, timeoutMs: number): Promise<number> {
  return new Promise((done) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args, { cwd, stdio: "ignore" });
    } catch {
      done(-1);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      done(-1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code ?? -1);
    });
  });
}

/**
 * The checks cheap enough to run on every turn of a long run, so a report can
 * say "verified four minutes ago" rather than only at the very end.
 *
 * `command` is excluded because it runs a whole test suite: doing that per turn
 * turns an 8-hour run into a 20-hour one. It is evaluated once, at the end.
 */
export const CHEAP_CHECKS: ReadonlyArray<DoneWhen["kind"]> = ["file_exists", "file_contains"];

/**
 * Evaluate a job's `done_when`.
 *
 * Never throws — a broken assertion reports as a failed check, because an
 * exception here would be indistinguishable from the job itself failing and
 * would send the operator looking in the wrong place.
 *
 * `kinds` restricts which check kinds are evaluated at all (see `CHEAP_CHECKS`).
 * Omit it to evaluate whatever the spec declares, which is what every existing
 * caller does.
 */
export async function verifyDoneWhen(
  spec: DoneWhen | null | undefined,
  workspaceRoot: string | null,
  kinds?: ReadonlyArray<DoneWhen["kind"]>,
): Promise<DoneCheck> {
  if (!spec) return UNCHECKED;
  // Filtered out is NOT failed. A skipped check reported as a failure would mark
  // every mid-run turn as broken, which is the opposite of informative. It is
  // also not UNCHECKED's "nothing was declared": an assertion exists here and
  // simply has not run yet, and saying the wrong one of those in a report is how
  // an unverified run gets read as an unverifiable one.
  if (kinds && !kinds.includes(spec.kind)) {
    return {
      passed: true,
      checked: false,
      detail: `not evaluated this turn — a \`${spec.kind}\` check runs once, at the end`,
    };
  }

  try {
    switch (spec.kind) {
      case "file_exists": {
        const target = within(workspaceRoot, spec.path!);
        const ok = await stat(target).then(() => true).catch(() => false);
        return {
          passed: ok,
          checked: true,
          detail: ok ? `verified: ${spec.path} exists` : `FAILED: ${spec.path} does not exist`,
        };
      }
      case "file_contains": {
        const target = within(workspaceRoot, spec.path!);
        const body = await readFile(target, "utf8").catch(() => null);
        if (body === null) {
          return { passed: false, checked: true, detail: `FAILED: ${spec.path} could not be read` };
        }
        const ok = body.includes(spec.value!);
        return {
          passed: ok,
          checked: true,
          detail: ok
            ? `verified: ${spec.path} contains the expected text`
            : `FAILED: ${spec.path} does not contain ${JSON.stringify(spec.value!.slice(0, 60))}`,
        };
      }
      case "command": {
        const cwd = workspaceRoot ?? process.cwd();
        const code = await runCommand(spec.value!, cwd, spec.timeoutMs ?? 60_000);
        return {
          passed: code === 0,
          checked: true,
          detail:
            code === 0
              ? `verified: \`${spec.value}\` exited 0`
              : `FAILED: \`${spec.value}\` exited ${code}`,
        };
      }
    }
  } catch (err) {
    return { passed: false, checked: true, detail: `FAILED: check errored — ${String(err)}` };
  }
}
