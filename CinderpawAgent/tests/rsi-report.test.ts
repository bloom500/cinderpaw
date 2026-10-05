/**
 * S1.6 of the AgentLoop evolution spec: the campaign report. Rank agreement
 * on known rankings, cost-AUC on a known curve, E1 with the H18 test-retest
 * rule, and "Pentru Darius": every INT line, first, without technical words.
 * E1 and E2 run end to end on the stub (fake executor, real evaluator logic
 * on the host) and produce a report.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoopArm, agentLoopPlan, type AgentLoopArmOptions, type AgentLoopArmRun } from "../src/rsi/infra/arms.ts";
import { runPairedCampaign, type CampaignManifest } from "../src/rsi/infra/campaign.ts";
import { rngOf } from "../src/rsi/infra/fixtures.ts";
import type { IsolationBackend } from "../src/rsi/l3-code/isolation.ts";
import type { ExecutorRun } from "../src/rsi/research/agent-executor.ts";
import { buildRepairSet, canaries, writeRepo } from "../src/rsi/research/families/build-repair.ts";
import { costAuc, judgeE1, kendallTau, kendallTauInterval, renderReport, TECHNICAL_WORDS } from "../src/rsi/research/report.ts";

describe("Kendall tau", () => {
  test("known rankings: identical 1, reversed -1, one swap of four 2/3", () => {
    expect(kendallTau([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(kendallTau([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    expect(kendallTau([1, 2, 3, 4], [1, 2, 4, 3])).toBeCloseTo(4 / 6);
  });

  test("no variation on one side is NaN, not a number that looks like agreement", () => {
    expect(kendallTau([1, 1, 1], [1, 2, 3])).toBeNaN();
  });

  test("the interval contains tau and is seeded", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const b = [2, 1, 3, 5, 4, 6, 8, 7];
    const r = kendallTauInterval(a, b);
    expect(r.lo).toBeLessThanOrEqual(r.tau);
    expect(r.hi).toBeGreaterThanOrEqual(r.tau);
    expect(kendallTauInterval(a, b)).toEqual(r);
  });
});

describe("cost-AUC", () => {
  test("a known curve: two tasks of cost 1, both pass, budget 2 -> 0.25", () => {
    expect(costAuc([{ cost: 1, passed: true }, { cost: 1, passed: true }], 2)).toBeCloseTo(0.25);
  });

  test("the cheaper agent with the same passes scores higher", () => {
    const cheap = costAuc([{ cost: 1, passed: true }, { cost: 1, passed: true }], 10);
    const dear = costAuc([{ cost: 4, passed: true }, { cost: 4, passed: true }], 10);
    expect(cheap).toBeGreaterThan(dear);
  });

  test("passes after the budget is spent do not count", () => {
    expect(costAuc([{ cost: 5, passed: true }], 2)).toBe(0);
  });
});

const K = 8;
const strong = Array.from({ length: K }, (_, i) => i / K);

describe("E1 with test-retest (H18)", () => {
  test("genomes that do not differ: inconclusive, never a pass by noise", () => {
    const rng = rngOf(7);
    const noise = () => Array.from({ length: K }, () => rng());
    const e = judgeE1({ first: noise(), retest: noise() }, { first: noise(), retest: noise() });
    expect(e.verdict).toBe("inconclusive");
  });

  test("both reliable, opposite orders: pass", () => {
    const rev = [...strong].reverse();
    expect(judgeE1({ first: strong, retest: strong }, { first: rev, retest: rev }).verdict).toBe("pass");
  });

  test("both reliable, same order and champion: fail", () => {
    expect(judgeE1({ first: strong, retest: strong }, { first: strong, retest: strong }).verdict).toBe("fail");
  });
});

// ---- end to end on the stub ------------------------------------------------

const set = buildRepairSet(3);
const plan = agentLoopPlan(set, "exec-1");
const byId = new Map(set.tasks.map((t) => [t.task.id, t]));

const hostCell: IsolationBackend = {
  name: "host-fake",
  available: async () => ({ ok: true }),
  run: async (dir, steps) =>
    steps.map((s) => {
      const [script, spec] = s.argv.slice(3);
      const r = Bun.spawnSync([process.execPath, "-e", script!, spec!, dir]);
      return { exitCode: r.exitCode, stdout: "", stderr: "", timedOut: false };
    }),
};

/** A stub agent of skill `p`: repairs a task when a seeded draw is below p. */
function stubAgent(name: string, p: number, seed: number): AgentLoopArmOptions["execute"] {
  const rng = rngOf(seed);
  return async (task) => {
    const t = byId.get(task.id)!;
    const out = mkdtempSync(join(tmpdir(), "cp-rep-"));
    writeRepo(rng() < p ? t.reference : t.repo, out);
    const run: ExecutorRun = {
      taskId: task.id,
      executorHash: name,
      modelId: "stub",
      terminal: "done",
      usage: { inputTokens: 100, outputTokens: 20, toolCalls: 1, usd: 0, calls: 1, wallMs: 1 },
      workspaceAfter: "h",
    };
    return { run, workspaceDir: out };
  };
}

const armOf = (name: string, execute: AgentLoopArmOptions["execute"]) =>
  agentLoopArm({
    tasks: plan.tasks,
    checks: set.checks,
    canaries: canaries(set, mkdtempSync(join(tmpdir(), "cp-rep-can-"))),
    evalCell: hostCell,
    executorHash: name,
    execute,
  });

/** The AgentLoop fitness of one stub genome: its promotion pass rate. */
async function agentLoopScore(p: number, seed: number): Promise<number> {
  const run = (await armOf(`g${p}`, stubAgent(`g${p}`, p, seed))({ seed, train: [] })) as AgentLoopArmRun;
  let passed = 0;
  for (const t of plan.partitions.promotion) if (await run.solve(t)) passed++;
  return passed / plan.partitions.promotion.length;
}

const manifest: CampaignManifest = {
  id: "e2-stub",
  seeds: [1, 2],
  arms: ["base", "cand"],
  partitions: plan.partitions,
  usdCap: 0,
  wallMsCap: 600_000,
  agentLoop: plan.agentLoop,
};

describe("end to end on the stub", () => {
  test("E1: K=8 stub genomes scored twice on the AgentLoop fitness, judged with the suite scores, reported", async () => {
    // ponytail: the 33-item suite is not runnable in this harness; its
    // scores are given. Genome skill 0, 1/7, ..., 1 makes both fitnesses
    // reliable and in the same order, so E1 must say "fail".
    const skills = Array.from({ length: K }, (_, i) => i / (K - 1));
    const first: number[] = [];
    const retest: number[] = [];
    for (const [i, p] of skills.entries()) {
      first.push(await agentLoopScore(p, 100 + i));
      retest.push(await agentLoopScore(p, 200 + i));
    }
    const e1 = judgeE1({ first: skills, retest: skills }, { first, retest });
    expect(e1.verdict).not.toBe("pass");
    const result = await runPairedCampaign(manifest, { base: armOf("a", stubAgent("a", 0, 1)), cand: armOf("b", stubAgent("b", 1, 2)) });
    const md = renderReport({ manifest, result, runs: [], verdicts: [], startedBy: "Darius", startedAt: "2026-10-05T10:00", tier: "Micro", e1 });
    expect(md).toContain("### E1");
    expect(md).toContain(`verdict: ${e1.verdict}`);
  }, 300_000);

  test("E2 (stub): a paired campaign produces a report that opens with Pentru Darius, every INT line, no technical words", async () => {
    const runs: ExecutorRun[] = [];
    const verdicts: AgentLoopArmRun["verdicts"] = [];
    const watched = (name: string, p: number, seed: number) => {
      const arm = armOf(name, stubAgent(name, p, seed));
      return async (ctx: Parameters<typeof arm>[0]) => {
        const r = (await arm(ctx)) as AgentLoopArmRun;
        const solve = r.solve;
        r.solve = async (t) => {
          const ok = await solve(t);
          runs.push(r.runs.at(-1)!);
          if (r.verdicts.length) verdicts.push(r.verdicts.at(-1)!);
          return ok;
        };
        return r;
      };
    };
    const result = await runPairedCampaign(manifest, { base: watched("a", 0, 1), cand: watched("b", 1, 2) });
    expect(result.samples).toEqual([
      { baseline: 0, candidate: 1 },
      { baseline: 0, candidate: 1 },
    ]);
    const md = renderReport({ manifest, result, runs, verdicts, startedBy: "Darius", startedAt: "2026-10-05T10:00", tier: "Micro" });

    expect(md.startsWith("## Pentru Darius")).toBe(true);
    const darius = md.split("## Technical")[0]!;
    const firstLine = darius.split("\n").find((l) => l.startsWith("- "))!;
    expect(firstLine).toContain("Cheltuit 0.0000 $ din plafonul 0.0000 $");
    expect(firstLine).toContain("Micro");
    for (let i = 1; i <= 18; i++) expect(darius).toContain(`INT-${i}:`);
    for (const w of TECHNICAL_WORDS) expect(darius).not.toMatch(new RegExp(`\\b${w}`, w === "RSI" ? "" : "i"));
    expect(md).not.toMatch(/\bRSI\b/);
    // 2 seeds x 2 agents x 3 tasks, all graded.
    expect(darius).toContain("INT-6: Note date de un program din afara agentului: 12 din 12");
    expect(darius).toContain("cel mai bun agent 100.0%, cel mai slab 0.0%");
    // One agent passed everything: the set is retired, not "under the ceiling".
    expect(darius).toContain("INT-18: Fara plafon: un agent a trecut peste 90%");
    expect(md).toContain("sub-check builds: 6/12");
    expect(md).toContain("gate (E2 global criteria): reject");
  }, 300_000);
});
