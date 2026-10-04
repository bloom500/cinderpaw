/**
 * S1.2 of the AgentLoop evolution spec: the external evaluator. It grades a
 * workspace the executor left behind, inside an isolation cell, with checks
 * the executor never saw. Two layers, like `rsi-isolation.test.ts`: a fake
 * cell that interprets the check commands against a temp dir, and real
 * Docker when it answers (skipped loudly otherwise).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type ExecResult } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation, type IsolatedStep, type IsolationBackend, type RunOptions } from "../src/rsi/l3-code/isolation.ts";
import { evaluate, runCanaries, type Check, type CheckRegistry } from "../src/rsi/research/agent-evaluator.ts";
import type { AgentTask } from "../src/rsi/research/task-family.ts";

const code = (exitCode: number, timedOut = false): ExecResult => ({ exitCode, stdout: "", stderr: "", timedOut });

/** Runs the evaluator's own step shapes against a host dir. Test-only: the
 *  real evaluator never runs a check on the host. */
function fakeCell(over: Partial<{ available: IsolationBackend["available"]; result: (s: IsolatedStep) => ExecResult | undefined }> = {}) {
  const runs: { dir: string; steps: IsolatedStep[]; opts?: RunOptions }[] = [];
  const cell: IsolationBackend = {
    name: "fake",
    available: over.available ?? (async () => ({ ok: true, note: "fake" })),
    async run(dir, steps, opts) {
      runs.push({ dir, steps, opts });
      return steps.map((s) => {
        const forced = over.result?.(s);
        if (forced) return forced;
        const [cmd, ...a] = s.argv;
        if (cmd === "test") return code(existsSync(join(dir, a[1]!)) ? 0 : 1);
        if (cmd === "grep") return code(existsSync(join(dir, a[3]!)) && readFileSync(join(dir, a[3]!), "utf8").includes(a[2]!) ? 0 : 1);
        if (cmd === "true") return code(0);
        return code(1);
      });
    },
  };
  return { cell, runs };
}

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-ws-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

const task = (checkId: string, kind: Check["kind"]): AgentTask => ({
  id: `t-${checkId}`,
  familyId: "build-repair",
  templateId: "missing-dep",
  seed: 1,
  instruction: "Fix the build.",
  workspaceImage: "a".repeat(64),
  budget: { maxInputTokens: 1, maxOutputTokens: 1, maxToolCalls: 1, maxWallMs: 1, maxUsd: 0 },
  verifier: { kind, checkId },
});

const checks: CheckRegistry = {
  report: { kind: "file_exists", path: "out/report.md" },
  total: { kind: "file_contains", path: "out/report.md", text: "Total: 1,240" },
  builds: { kind: "command", argv: ["true"], timeoutMs: 5_000 },
  breaks: { kind: "command", argv: ["false"], timeoutMs: 5_000 },
  all: {
    kind: "composite",
    checks: [
      { id: "has-report", check: { kind: "file_exists", path: "out/report.md" } },
      { id: "has-total", check: { kind: "file_contains", path: "out/report.md", text: "Total: 1,240" } },
      { id: "no-distractor", check: { kind: "command", argv: ["false"], timeoutMs: 5_000 } },
    ],
  },
};

const graded = async (checkId: string, kind: Check["kind"], files: Record<string, string>, cell = fakeCell().cell) => {
  const r = await evaluate({ cell, task: task(checkId, kind), executorHash: "e1", workspaceDir: workspace(files), checks });
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.verdict;
};

describe("each verifier kind passes and fails", () => {
  test("file_exists", async () => {
    expect((await graded("report", "file_exists", { "out/report.md": "x" })).passed).toBe(true);
    expect((await graded("report", "file_exists", {})).passed).toBe(false);
  });

  test("file_contains", async () => {
    expect((await graded("total", "file_contains", { "out/report.md": "Total: 1,240\n" })).passed).toBe(true);
    expect((await graded("total", "file_contains", { "out/report.md": "Total: 9" })).passed).toBe(false);
  });

  test("command", async () => {
    expect((await graded("builds", "command", {})).passed).toBe(true);
    expect((await graded("breaks", "command", {})).passed).toBe(false);
  });

  test("a check that runs out of time fails", async () => {
    const { cell } = fakeCell({ result: () => code(-1, true) });
    expect((await graded("builds", "command", {}, cell)).passed).toBe(false);
  });
});

describe("composite checks give a graded score", () => {
  test("two of three sub-checks: not passed, score 2/3, each sub-check named", async () => {
    const v = await graded("all", "composite", { "out/report.md": "Total: 1,240" });
    expect(v.passed).toBe(false);
    expect(v.score).toBeCloseTo(2 / 3);
    expect(v.subChecks).toEqual([
      { id: "has-report", passed: true },
      { id: "has-total", passed: true },
      { id: "no-distractor", passed: false },
    ]);
  });

  test("the verdict names the task, the executor and the evaluator", async () => {
    const v = await graded("report", "file_exists", { "out/report.md": "x" });
    expect(v.taskId).toBe("t-report");
    expect(v.executorHash).toBe("e1");
    expect(v.evaluatorHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.score).toBe(1);
  });
});

describe("refusals: a run that cannot be graded is not a failed task", () => {
  test("no cell: refused with the cell's own reason, nothing runs", async () => {
    const { cell, runs } = fakeCell({ available: async () => ({ ok: false, reason: "Docker is not installed." }) });
    const r = await evaluate({ cell, task: task("report", "file_exists"), executorHash: "e1", workspaceDir: workspace({}), checks });
    expect(r).toEqual({ ok: false, reason: "Docker is not installed." });
    expect(runs).toHaveLength(0);
  });

  test("the cell broke (not a check result): refused, not scored as a fail", async () => {
    const broken = (): ExecResult => ({ exitCode: -1, stdout: "", stderr: "docker create failed: no space", timedOut: false });
    const { cell } = fakeCell({ result: broken });
    const r = await evaluate({ cell, task: task("builds", "command"), executorHash: "e1", workspaceDir: workspace({}), checks });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no space");
  });

  test("unknown check id, or a kind that differs from the task's reference", async () => {
    const { cell } = fakeCell();
    const ws = workspace({});
    const unknown = await evaluate({ cell, task: task("ghost", "command"), executorHash: "e1", workspaceDir: ws, checks });
    const mismatch = await evaluate({ cell, task: task("builds", "file_exists"), executorHash: "e1", workspaceDir: ws, checks });
    expect(unknown.ok).toBe(false);
    expect(mismatch.ok).toBe(false);
  });

  test("a path outside the workspace is refused before anything runs", async () => {
    const { cell, runs } = fakeCell();
    for (const path of ["../secret", "/etc/passwd", "a/../../b", "C:\\Windows"]) {
      const r = await evaluate({
        cell,
        task: task("p", "file_exists"),
        executorHash: "e1",
        workspaceDir: workspace({}),
        checks: { p: { kind: "file_exists", path } },
      });
      expect(r.ok).toBe(false);
    }
    expect(runs).toHaveLength(0);
  });

  test("an empty or nested composite is refused", async () => {
    const { cell } = fakeCell();
    const ws = workspace({});
    const empty = await evaluate({ cell, task: task("c", "composite"), executorHash: "e1", workspaceDir: ws, checks: { c: { kind: "composite", checks: [] } } });
    const nested = await evaluate({
      cell,
      task: task("c", "composite"),
      executorHash: "e1",
      workspaceDir: ws,
      checks: { c: { kind: "composite", checks: [{ id: "x", check: { kind: "composite", checks: [] } as never }] } },
    });
    expect(empty.ok).toBe(false);
    expect(nested.ok).toBe(false);
  });
});

describe("the workspace is untrusted", () => {
  test("checks always run on the plain base image, never on a lockfile the executor could have written", async () => {
    const { cell, runs } = fakeCell();
    await graded("builds", "command", { "bun.lock": "{ evil }" }, cell);
    expect(runs[0]!.opts).toEqual({ image: "base" });
  });

  test("DockerIsolation in base mode never builds an image from the copied tree", async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string[]): Promise<ExecResult> => {
      calls.push(cmd);
      return { exitCode: 0, stdout: cmd[1] === "create" ? "cid\n" : "", stderr: "", timedOut: false };
    };
    const iso = new DockerIsolation({ exec, baseImage: "oven/bun:test-slim" });
    await iso.run(workspace({ "bun.lock": "{ evil }" }), [{ name: "t", argv: ["true"], timeoutMs: 1_000 }], { image: "base" });
    expect(calls.some((c) => c[1] === "build")).toBe(false);
    expect(calls.find((c) => c[1] === "create")).toContain("oven/bun:test-slim");
  });
});

describe("evaluator hash", () => {
  test("changes when the check changes, stays when it does not", async () => {
    const ws = { "out/report.md": "Total: 1,240" };
    const a = await graded("total", "file_contains", ws);
    const b = await graded("total", "file_contains", ws);
    const { cell } = fakeCell();
    const changed = await evaluate({
      cell,
      task: task("total", "file_contains"),
      executorHash: "e1",
      workspaceDir: workspace(ws),
      checks: { total: { kind: "file_contains", path: "out/report.md", text: "Total: 1,241" } },
    });
    expect(a.evaluatorHash).toBe(b.evaluatorHash);
    expect(changed.ok && changed.verdict.evaluatorHash).not.toBe(a.evaluatorHash);
  });
});

describe("canaries catch a broken evaluator", () => {
  const known = (expect: "pass" | "fail") => ({
    name: `known-${expect}`,
    task: task("total", "file_contains"),
    workspaceDir: workspace({ "out/report.md": expect === "pass" ? "Total: 1,240" : "Total: 0" }),
    expect,
  });

  test("a working evaluator: known-pass passes, known-fail fails, no problems", async () => {
    expect(await runCanaries(fakeCell().cell, checks, [known("pass"), known("fail")])).toEqual([]);
  });

  test("an evaluator that passes everything trips the known-fail canary", async () => {
    const { cell } = fakeCell({ result: () => code(0) });
    const problems = await runCanaries(cell, checks, [known("pass"), known("fail")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("known-fail");
  });

  test("a canary that cannot run is a problem, not a pass", async () => {
    const { cell } = fakeCell({ available: async () => ({ ok: false, reason: "Docker is not running." }) });
    const problems = await runCanaries(cell, checks, [known("pass")]);
    expect(problems.join("\n")).toContain("Docker is not running.");
  });
});

async function dockerUp(): Promise<boolean> {
  try {
    const r = await bunExec(["docker", "version", "--format", "{{.Server.Os}}"], { cwd: tmpdir(), timeoutMs: 15_000 });
    return r.exitCode === 0 && r.stdout.trim() === "linux";
  } catch {
    return false;
  }
}

const up = await dockerUp();
if (!up) console.error("rsi-agent-evaluator: real Docker checks SKIPPED, Docker is not running here");

describe.skipIf(!up)("the evaluator against real Docker", () => {
  test("a composite verdict from inside a cell, lockfile in the workspace ignored", async () => {
    const cell = new DockerIsolation({ exec: bunExec, limits: { pids: 64, memory: "256m", cpus: 1, scratch: "64m", wallMs: 120_000 } });
    const r = await evaluate({
      cell,
      task: task("all", "composite"),
      executorHash: "e1",
      workspaceDir: workspace({ "out/report.md": "Total: 1,240", "bun.lock": "not a lockfile" }),
      checks,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.subChecks.map((s) => s.passed)).toEqual([true, true, false]);
  }, 300_000);
});
