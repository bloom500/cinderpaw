/**
 * S1.5 of the AgentLoop evolution spec: the AgentLoop arm in the paired
 * campaign runner. The executor is faked (it writes a repository and says
 * `done`); the evaluator is real, its cell replaced by one that runs the F1
 * check scripts on the host exactly as the Docker cell would.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoopArm, agentLoopPlan, type AgentLoopArmOptions, type AgentLoopArmRun } from "../src/rsi/infra/arms.ts";
import { runPairedCampaign, type CampaignManifest } from "../src/rsi/infra/campaign.ts";
import type { Repo } from "../src/rsi/infra/fixtures.ts";
import { bunExec } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation, type IsolationBackend } from "../src/rsi/l3-code/isolation.ts";
import { runExecutor, type ExecutorRun } from "../src/rsi/research/agent-executor.ts";
import type { BrokerModel } from "../src/rsi/research/task-budget.ts";
import { buildRepairSet, canaries, writeRepo } from "../src/rsi/research/families/build-repair.ts";

const set = buildRepairSet(3);
const plan = agentLoopPlan(set, "exec-1");

/** The evaluation cell, on the host: runs each check's `bun -e` script
 *  against the workspace dir (the argv's last item is the cell path). */
const hostCell: IsolationBackend = {
  name: "host-fake",
  available: async () => ({ ok: true }),
  run: async (dir, steps) =>
    steps.map((s) => {
      const [script, spec] = s.argv.slice(3);
      const r = Bun.spawnSync([process.execPath, "-e", script!, spec!, dir]);
      return { exitCode: r.exitCode, stdout: "", stderr: r.stderr.toString(), timedOut: false };
    }),
};

const usage = (usd = 0) => ({ inputTokens: 100, outputTokens: 20, toolCalls: 1, usd, calls: 1, wallMs: 5 });

/** A fake executor: `repair` decides what the agent leaves behind. */
function executor(
  repair: (taskId: string) => Repo | null,
  over: Partial<ExecutorRun> = {},
): AgentLoopArmOptions["execute"] & { calls: number } {
  const f = async (task: { id: string }) => {
    f.calls++;
    const repo = repair(task.id);
    const out = mkdtempSync(join(tmpdir(), "cp-arm-out-"));
    if (repo) writeRepo(repo, out);
    const run: ExecutorRun = {
      taskId: task.id,
      executorHash: "exec-1",
      modelId: "stub",
      terminal: "done",
      usage: usage(),
      workspaceAfter: "h",
      ...over,
    };
    return { run, workspaceDir: run.terminal === "done" ? out : undefined };
  };
  f.calls = 0;
  return f as AgentLoopArmOptions["execute"] & { calls: number };
}

const byId = new Map(set.tasks.map((t) => [t.task.id, t]));
const fixes = executor((id) => byId.get(id)!.reference);
const leavesBroken = executor((id) => byId.get(id)!.repo);

const arm = (execute: AgentLoopArmOptions["execute"]) =>
  agentLoopArm({
    tasks: plan.tasks,
    checks: set.checks,
    canaries: canaries(set, mkdtempSync(join(tmpdir(), "cp-arm-can-"))),
    evalCell: hostCell,
    executorHash: "exec-1",
    execute,
  });

const manifest = (over: Partial<CampaignManifest> = {}): CampaignManifest => ({
  id: "f1-stub",
  seeds: [1],
  arms: ["base", "cand"],
  partitions: plan.partitions,
  usdCap: 0,
  wallMsCap: 600_000,
  agentLoop: plan.agentLoop,
  ...over,
});

describe("stub campaign end to end", () => {
  test("the agent that repairs scores 1, the one that leaves it broken scores 0, graded by the evaluator", async () => {
    const r = await runPairedCampaign(manifest(), { base: arm(leavesBroken), cand: arm(fixes) });
    expect(r.stopped).toBeUndefined();
    expect(r.samples).toEqual([{ baseline: 0, candidate: 1 }]);
    expect(r.ledger.cand!.tokens).toBe(3 * 120);
  }, 120_000);

  test("E0 (same arm both sides) gives a zero delta on every seed", async () => {
    const r = await runPairedCampaign(manifest({ seeds: [1, 2] }), { base: arm(fixes), cand: arm(fixes) });
    expect(r.samples.every((s) => s.baseline === s.candidate)).toBe(true);
    expect(r.matched).toBe(true);
  }, 120_000);

  test("only promotion tasks reach the executor", async () => {
    const seen: string[] = [];
    const ex = executor((id) => (seen.push(id), byId.get(id)!.reference));
    await runPairedCampaign(manifest(), { base: arm(ex), cand: arm(ex) });
    const promo = new Set(plan.partitions.promotion.map((t) => t.id));
    expect(seen.length).toBe(6);
    expect(seen.every((id) => promo.has(id))).toBe(true);
  }, 120_000);
});

describe("the manifest", () => {
  test("its hash changes with the evaluator hash", async () => {
    const a = await runPairedCampaign(manifest(), { base: arm(fixes), cand: arm(fixes) });
    const changed = { ...plan.agentLoop, evaluatorHash: "other" };
    const b = await runPairedCampaign(manifest({ agentLoop: changed }), { base: arm(fixes), cand: arm(fixes) });
    expect(a.manifestHash).not.toBe(b.manifestHash);
  }, 120_000);
});

describe("stops", () => {
  test("an arm spending above the cap stops the campaign mid-partition, and the spend is kept", async () => {
    const paid = executor((id) => byId.get(id)!.reference, { usage: usage(0.01) });
    const r = await runPairedCampaign(manifest({ usdCap: 0.015 }), { base: arm(paid), cand: arm(paid) });
    expect(r.stopped).toContain("usd cap");
    expect(paid.calls).toBe(2);
    expect(r.ledger.base!.usd).toBeCloseTo(0.02);
    expect(r.samples).toEqual([]);
  }, 120_000);

  test("budget exhausted is a failed task, never graded", async () => {
    const out = executor(() => null, { terminal: "budget_exhausted", reason: "budget exhausted: tool calls" });
    const r = await runPairedCampaign(manifest(), { base: arm(out), cand: arm(fixes) });
    expect(r.samples).toEqual([{ baseline: 0, candidate: 1 }]);
  }, 120_000);

  test("a refused executor stops the campaign with its reason instead of scoring zeros", async () => {
    const no = executor(() => null, { terminal: "refused", reason: "Docker is not running." });
    const r = await runPairedCampaign(manifest(), { base: arm(no), cand: arm(fixes) });
    expect(r.stopped).toContain("Docker is not running.");
    expect(r.matched).toBe(false);
  }, 120_000);

  test("a wrong canary stops the run before any task", async () => {
    const liar: IsolationBackend = { ...hostCell, run: async (_d, steps) => steps.map(() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })) };
    const ex = executor((id) => byId.get(id)!.reference);
    const bad = agentLoopArm({ tasks: plan.tasks, checks: set.checks, canaries: canaries(set, mkdtempSync(join(tmpdir(), "cp-c-"))), evalCell: liar, executorHash: "e", execute: ex });
    const r = await runPairedCampaign(manifest(), { base: bad, cand: arm(fixes) });
    expect(r.stopped).toContain("evaluator is broken");
    expect(ex.calls).toBe(0);
  }, 120_000);
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
if (!up) console.error("rsi-agentloop-arm: real Docker chain SKIPPED, Docker is not running here");

describe.skipIf(!up)("the whole chain on real Docker, stub model", () => {
  test("real agent in a cell on one F1 task, graded by the real evaluator: done, graded, not repaired", async () => {
    const pkg = join(import.meta.dir, "..");
    const stub: BrokerModel = {
      id: "stub",
      usdPerMInput: 0,
      usdPerMOutput: 0,
      call: async () => ({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
    };
    const iso = new DockerIsolation({ exec: bunExec, limits: { pids: 256, memory: "1g", cpus: 2, scratch: "128m", wallMs: 120_000 } });
    const execute: AgentLoopArmOptions["execute"] = (task, workspaceDir) =>
      runExecutor({ iso, task, workspaceDir, agentSrcDir: join(pkg, "src"), depsDir: pkg, model: stub, genome: { temperature: 0.4 }, executorHash: "exec-real", caps: { maxBytes: 10_000_000, maxEntries: 1_000 } });
    const one = { ...plan.partitions, promotion: plan.partitions.promotion.slice(0, 1) };
    // Both sides graded by the evaluator in its own Docker cell.
    const realArm = agentLoopArm({ tasks: plan.tasks, checks: set.checks, canaries: canaries(set, mkdtempSync(join(tmpdir(), "cp-rc-"))), evalCell: iso, executorHash: "exec-real", execute });
    let armRun: AgentLoopArmRun | undefined;
    const watched: typeof realArm = async (ctx) => (armRun = (await realArm(ctx)) as AgentLoopArmRun);
    const r = await runPairedCampaign(manifest({ partitions: one, seeds: [1] }), { base: realArm, cand: watched });
    if (r.stopped) throw new Error(r.stopped);
    expect(armRun!.runs[0]!.terminal).toBe("done");
    expect(armRun!.verdicts.length).toBe(1);
    expect(armRun!.verdicts[0]!.passed).toBe(false);
    expect(r.samples).toEqual([{ baseline: 0, candidate: 0 }]);
  }, 900_000);
});
