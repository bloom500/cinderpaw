/**
 * S1.4 of the AgentLoop evolution spec: family F1 (build repair) on disk.
 * Each planted failure fails its check, each reference repair passes, and a
 * repair that games the build by gutting another file is caught by `intact`.
 * The checks run here exactly as the evaluation cell runs them (`bun -e` on
 * the script in the argv), minus the `cd /tmp` wrapper.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/rsi/infra/fixtures.ts";
import { bunExec } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation } from "../src/rsi/l3-code/isolation.ts";
import { evaluate, runCanaries } from "../src/rsi/research/agent-evaluator.ts";
import { buildRepairSet, canaries, PLAN, writeRepo, type BuildRepairTask } from "../src/rsi/research/families/build-repair.ts";
import { partitionOf, validateFamily, validateTask } from "../src/rsi/research/task-family.ts";

const set = buildRepairSet();
const firstOf = (template: string) => set.tasks.find((t) => t.task.templateId === template)!;

/** Run every sub-check of the task's composite on `repo`, as the cell would. */
function grade(t: BuildRepairTask, repo: Repo): Record<string, boolean> {
  const dir = mkdtempSync(join(tmpdir(), "cp-f1-"));
  writeRepo(repo, dir);
  const check = set.checks[t.task.verifier.checkId]!;
  if (check.kind !== "composite") throw new Error("expected a composite");
  const out: Record<string, boolean> = {};
  for (const { id, check: leaf } of check.checks) {
    if (leaf.kind !== "command") throw new Error("expected a command");
    const [script, spec, cellRoot] = leaf.argv.slice(3);
    expect(cellRoot).toBe("/app/work");
    out[id] = Bun.spawnSync([process.execPath, "-e", script!, spec!, dir]).exitCode === 0;
  }
  return out;
}

describe("the family", () => {
  test("is valid, one template per partition, 12 tasks per partition, every task valid", () => {
    expect(validateFamily(set.family)).toEqual([]);
    for (const part of Object.keys(PLAN) as (keyof typeof PLAN)[]) {
      const inPart = set.tasks.filter((t) => partitionOf(set.family, t.task.templateId) === part);
      expect(inPart.length).toBe(12);
    }
    for (const t of set.tasks) expect(validateTask(t.task, set.family)).toEqual([]);
  });

  test("no two tasks start from the same repository, and seeds are stable", () => {
    expect(new Set(set.tasks.map((t) => t.task.workspaceImage)).size).toBe(set.tasks.length);
    expect(buildRepairSet().tasks.map((t) => t.task.id)).toEqual(set.tasks.map((t) => t.task.id));
  });

  test("the verifier never enters the workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-f1-ws-"));
    const t = set.tasks[0]!;
    writeRepo(t.repo, dir);
    const all = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
      .join("\n");
    expect(all).not.toContain("checkRepo");
    expect(all).not.toContain(t.task.verifier.checkId);
    expect(t.task.instruction).not.toContain("intact");
  });
});

describe("the checks, run as the cell runs them", () => {
  for (const template of Object.values(PLAN).flat()) {
    test(`${template}: the planted failure fails, the reference repair passes`, () => {
      const t = firstOf(template);
      const broken = grade(t, t.repo);
      expect(broken.builds).toBe(false);
      expect(broken.fixed).toBe(false);
      expect(broken.intact).toBe(true);
      expect(grade(t, t.reference)).toEqual({ builds: true, fixed: true, intact: true });
    });
  }

  test("a hack that builds by gutting an unrelated file fails intact", () => {
    // bad-env-name, "fixed" by dropping the env read from the source too.
    const t = firstOf("bad-env-name");
    const src = Object.keys(t.reference).find((p) => p.startsWith("src/") && p !== "src/index.ts")!;
    const hacked = { ...t.reference, [src]: t.reference[src]!.replace(/process\.env\.[A-Z_]+/, '"x"') };
    expect(grade(t, hacked)).toEqual({ builds: true, fixed: true, intact: false });
  });

  test("broken-import fixed with a shim file instead of the import fails `fixed`", () => {
    const t = firstOf("broken-import");
    const mod = t.repo["src/index.ts"]!.match(/\.\/([a-z]+)-v2\.ts/)![1]!;
    const shim = { ...t.repo, [`src/${mod}-v2.ts`]: `export { run } from "./${mod}.ts";\n` };
    const g = grade(t, shim);
    expect(g.builds).toBe(true);
    expect(g.fixed).toBe(false);
  });

  test("a deleted file fails intact", () => {
    const t = firstOf("missing-dep");
    const { "tsconfig.json": _gone, ...rest } = t.reference;
    expect(grade(t, rest).intact).toBe(false);
  });
});

describe("canaries", () => {
  test("a pair per family: broken must fail, reference must pass", () => {
    const pair = canaries(set, mkdtempSync(join(tmpdir(), "cp-f1-can-")));
    expect(pair.map((c) => c.expect)).toEqual(["fail", "pass"]);
    expect(Object.values(grade(set.tasks[0]!, set.tasks[0]!.repo)).every(Boolean)).toBe(false);
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
if (!up) console.error("rsi-family-build-repair: real Docker checks SKIPPED, Docker is not running here");

describe.skipIf(!up)("F1 against the real evaluator cell", () => {
  const cell = new DockerIsolation({ exec: bunExec, limits: { pids: 64, memory: "256m", cpus: 1, scratch: "64m", wallMs: 120_000 } });

  test("the canary pair comes back right", async () => {
    expect(await runCanaries(cell, set.checks, canaries(set, mkdtempSync(join(tmpdir(), "cp-f1-dk-"))))).toEqual([]);
  }, 300_000);

  test("a bunfig.toml preload planted in the workspace does not run inside the check", async () => {
    const t = set.tasks[0]!;
    const dir = mkdtempSync(join(tmpdir(), "cp-f1-dk-"));
    // The preload would force every check to pass; the broken repo must still
    // fail builds and fixed (intact holds: extra files touch no tracked file).
    writeRepo({ ...t.repo, "bunfig.toml": 'preload = ["./p.ts"]\n', "p.ts": "process.exit(0);\n" }, dir);
    const r = await evaluate({ cell, task: t.task, executorHash: "e", workspaceDir: dir, checks: set.checks });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.subChecks.map((s) => s.passed)).toEqual([false, false, true]);
  }, 300_000);
});
