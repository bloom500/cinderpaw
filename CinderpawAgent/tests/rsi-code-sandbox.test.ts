/**
 * Faza 2 Slice 2 — the sandbox eval runner lifecycle, pinned over a fake
 * ExecFn: sequencing, fail-fast stages, measurements-not-gates, and
 * teardown on EVERY path. Plus one real-git integration test (worktree
 * create → apply → destroy against a throwaway repo; the cell faked).
 *
 * S0 (2026-09-13): every step that RUNS the candidate's code goes through an
 * `IsolationBackend`. These tests pin that nothing the candidate wrote ever
 * reaches `exec` on the host, and that no backend means refused, not run.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateCodePatch,
  parseBunTestSummary,
  sumNumstat,
  bunExec,
  type ExecFn,
  type ExecResult,
} from "../src/rsi/l3-code/code-sandbox.ts";
import type { IsolatedStep, IsolationBackend } from "../src/rsi/l3-code/isolation.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr = "boom", exitCode = 1): ExecResult => ({
  exitCode,
  stdout: "",
  stderr,
  timedOut: false,
});

/** Fake exec that answers by command shape and records the call order. */
function fakeExec(
  answers: Partial<Record<string, ExecResult>>,
  calls: string[] = [],
): { exec: ExecFn; calls: string[] } {
  const exec: ExecFn = async (cmd) => {
    const key = keyOf(cmd);
    calls.push(key);
    return answers[key] ?? ok();
  };
  return { exec, calls };
}

function keyOf(cmd: string[]): string {
  if (cmd[0] === "git" && cmd[1] === "worktree") return `worktree_${cmd[2]}`;
  if (cmd[0] === "git" && cmd[1] === "apply") return cmd.includes("--numstat") ? "numstat" : "apply";
  return cmd.join(" ");
}

/** A cell that records what it was asked to run and answers per step name.
 *  The real one is Docker (`rsi-isolation.test.ts`); here the pipeline is
 *  the thing under test. */
function fakeIsolation(
  answers: Partial<Record<string, ExecResult>> = {},
  opts: { available?: boolean; reason?: string; calls?: string[] } = {},
): IsolationBackend {
  const calls = opts.calls ?? [];
  return {
    name: "fake",
    available: async () =>
      opts.available === false ? { ok: false, reason: opts.reason ?? "no cell" } : { ok: true, note: "fake" },
    run: async (_pkgDir: string, steps: IsolatedStep[]) => {
      calls.push(`isolation:${steps.map((s) => s.name).join(",")}`);
      return steps.map((s) => answers[s.name] ?? ok());
    },
  };
}

const genome = { patch: "diff --git a/x b/x\n", baseCommit: "abc123" };
const opts = (exec: ExecFn, calls: string[], answers: Partial<Record<string, ExecResult>> = {}) => ({
  repoRoot: "C:/fake/repo",
  exec,
  isolation: fakeIsolation(answers, { calls }),
});

describe("evaluateCodePatch — lifecycle over a fake exec", () => {
  test("happy path: full sequence, raw measurements, teardown last", async () => {
    const { exec, calls } = fakeExec({
      numstat: ok("5\t3\tsrc/rsi/x.ts\n2\t0\tsrc/rsi/y.ts\n"),
    });
    const r = await evaluateCodePatch(
      genome,
      opts(exec, calls, {
        tests: { exitCode: 1, stdout: "", stderr: " 42 pass\n 2 fail\n", timedOut: false },
        tsc: fail("", 2),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Failing tests / dirty tsc are MEASUREMENTS, not aborts.
      expect(r.measurements.testsPassed).toBe(42);
      expect(r.measurements.testsFailed).toBe(2);
      expect(r.measurements.testsExitCode).toBe(1);
      expect(r.measurements.tscExitCode).toBe(2);
      expect(r.measurements.buildExitCode).toBe(0);
      expect(r.measurements.changedLines).toBe(10);
    }
    expect(calls).toEqual([
      "worktree_add",
      "numstat",
      "apply",
      // One cell, three steps, in order. Nothing the candidate wrote ran
      // through `exec` on the host.
      "isolation:tests,tsc,build",
      "worktree_remove",
    ]);
  });

  test("patch null measures the unpatched base: same steps, nothing applied", async () => {
    const { exec, calls } = fakeExec({});
    const r = await evaluateCodePatch({ patch: null, baseCommit: "abc123" }, opts(exec, calls));
    expect(r.ok && r.measurements.changedLines).toBe(0);
    expect(calls).toEqual(["worktree_add", "isolation:tests,tsc,build", "worktree_remove"]);
  });

  test("no isolation backend → refused before any worktree exists", async () => {
    const { exec, calls } = fakeExec({});
    const r = await evaluateCodePatch(genome, { repoRoot: "C:/fake/repo", exec });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("isolation");
    expect(calls).toEqual([]);
  });

  test("backend unavailable → refused with ITS reason, nothing created", async () => {
    const { exec, calls } = fakeExec({});
    const reason = "Docker is installed but not running. Start Docker Desktop.";
    const r = await evaluateCodePatch(genome, {
      repoRoot: "C:/fake/repo",
      exec,
      isolation: fakeIsolation({}, { available: false, reason }),
    });
    expect(r).toEqual({ ok: false, stage: "isolation", reason });
    expect(calls).toEqual([]);
  });

  test("worktree create fails → hard failure, nothing else runs", async () => {
    const { exec, calls } = fakeExec({ worktree_add: fail("fatal: invalid reference") });
    const r = await evaluateCodePatch(genome, opts(exec, calls));
    expect(r).toEqual({ ok: false, stage: "worktree_create", reason: "fatal: invalid reference" });
    expect(calls).toEqual(["worktree_add"]);
  });

  test("patch apply fails → hard failure, the cell never runs, teardown still runs", async () => {
    const { exec, calls } = fakeExec({ apply: fail("error: patch does not apply") });
    const r = await evaluateCodePatch(genome, opts(exec, calls));
    expect(r).toEqual({ ok: false, stage: "patch_apply", reason: "error: patch does not apply" });
    expect(calls).toEqual(["worktree_add", "numstat", "apply", "worktree_remove"]);
  });

  test("a step killed by the wall clock is a MEASUREMENT, not an abort", async () => {
    const { exec, calls } = fakeExec({});
    const dead: ExecResult = { exitCode: -1, stdout: "", stderr: "killed: sandbox wall clock", timedOut: true };
    const r = await evaluateCodePatch(genome, opts(exec, calls, { tests: dead, tsc: dead, build: dead }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.measurements.testsExitCode).toBe(-1);
      expect(r.measurements.testsPassed).toBe(0);
      expect(r.measurements.buildExitCode).toBe(-1);
    }
    expect(calls[calls.length - 1]).toBe("worktree_remove");
  });

  test("git refuses teardown → fs sweep + prune, result unaffected", async () => {
    const { exec, calls } = fakeExec({ worktree_remove: fail("in use") });
    const r = await evaluateCodePatch(genome, opts(exec, calls));
    expect(r.ok).toBe(true);
    expect(calls[calls.length - 1]).toBe("worktree_prune");
  });
});

describe("parsers", () => {
  test("parseBunTestSummary reads bun's summary line", () => {
    expect(parseBunTestSummary(" 12 pass\n 3 fail\nRan 15 tests")).toEqual({
      passed: 12,
      failed: 3,
    });
    expect(parseBunTestSummary("garbage")).toEqual({ passed: 0, failed: 0 });
  });

  test("sumNumstat sums added+removed, skips binary '-' rows", () => {
    expect(sumNumstat("10\t2\ta.ts\n-\t-\tblob.bin\n1\t1\tb.ts\n")).toBe(14);
    expect(sumNumstat("")).toBe(0);
  });
});

describe("integration — real git worktree lifecycle", () => {
  test("create → apply → measure → destroy against a throwaway repo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cinderpaw-code-sbx-"));
    const scratch = mkdtempSync(join(tmpdir(), "cinderpaw-code-sbx-wt-"));
    try {
      // Tiny repo shaped like the monorepo: CinderpawAgent/src/rsi/<file>.
      const run = (args: string[]) =>
        bunExec(["git", ...args], { cwd: repo, timeoutMs: 30_000 });
      await run(["init", "-q"]);
      await run(["config", "user.email", "t@t"]);
      await run(["config", "user.name", "t"]);
      mkdirSync(join(repo, "CinderpawAgent", "src", "rsi"), { recursive: true });
      writeFileSync(join(repo, "CinderpawAgent", "src", "rsi", "x.ts"), "export const x = 1;\n");
      await run(["add", "-A"]);
      await run(["commit", "-qm", "base"]);
      const head = (await run(["rev-parse", "HEAD"])).stdout.trim();

      const patch = [
        "diff --git a/src/rsi/x.ts b/src/rsi/x.ts",
        "--- a/src/rsi/x.ts",
        "+++ b/src/rsi/x.ts",
        "@@ -1 +1 @@",
        "-export const x = 1;",
        "+export const x = 2;",
        "",
      ].join("\n");

      // Real exec for git; the cell faked so the test stays fast.
      const r = await evaluateCodePatch(
        { patch, baseCommit: head },
        { repoRoot: repo, scratchDir: scratch, exec: bunExec, isolation: fakeIsolation({ tests: ok(" 1 pass\n") }) },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.measurements.changedLines).toBe(2);
      // Destroy-always: scratch holds no worktree afterwards.
      const worktrees = (await run(["worktree", "list"])).stdout;
      expect(worktrees).not.toContain(scratch);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
