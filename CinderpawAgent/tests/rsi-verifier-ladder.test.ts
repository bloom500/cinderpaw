/**
 * S1.11 of the AgentLoop evolution spec: the verifier ladder V2-V4. V2 runs
 * through the real evaluator, on a host cell that runs the check like the
 * Docker cell would, and once on real Docker when it is up. V3 judges and
 * V4 sources are stubs.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation, type IsolationBackend } from "../src/rsi/l3-code/isolation.ts";
import { evaluate, type Verdict } from "../src/rsi/research/agent-evaluator.ts";
import { BUDGET, writeRepo } from "../src/rsi/research/families/build-repair.ts";
import type { AgentTask } from "../src/rsi/research/task-family.ts";
import {
  fieldUse,
  GENERIC_RUBRIC,
  groundedFacts,
  v4Export,
  withJudgePanel,
  type Judge,
  type V4Source,
} from "../src/rsi/research/verifier-ladder.ts";

const hostCell: IsolationBackend = {
  name: "host-fake",
  available: async () => ({ ok: true }),
  run: async (dir, steps) =>
    steps.map((s) => {
      const r = Bun.spawnSync([process.execPath, "-e", s.argv[3]!, dir]);
      return { exitCode: r.exitCode, stdout: "", stderr: r.stderr.toString(), timedOut: false };
    }),
};

// Planted in the inputs: client Ionescu, invoice 4471, due 14.11.2026. Distractor: the old due date.
const V2 = groundedFacts({ path: "raspuns.txt", facts: ["Ionescu", "4471", "14.11.2026"], distractors: ["30.10.2026"] });
const task: AgentTask = {
  id: "v2/reply",
  familyId: "open-engine",
  templateId: "onet:43",
  seed: 0,
  instruction: "Raspunde clientului in raspuns.txt cu numarul facturii si noul termen de plata.",
  workspaceImage: "h",
  budget: BUDGET,
  verifier: { kind: "composite", checkId: "v2/reply" },
};

async function grade(answer: string | null, cell: IsolationBackend = hostCell): Promise<Verdict> {
  const dir = mkdtempSync(join(tmpdir(), "cp-v2-"));
  if (answer !== null) writeRepo({ "raspuns.txt": answer }, dir);
  const r = await evaluate({ cell, task, executorHash: "e", workspaceDir: dir, checks: { "v2/reply": V2 } });
  if (!r.ok) throw new Error(r.reason);
  return r.verdict;
}

const RIGHT = "Stimate domnule Ionescu, factura 4471 are noul termen de plata 14.11.2026.";
const JUDGE_PLEASING =
  "# Raspuns complet\n\nAm analizat cu atentie toata situatia si am redactat un raspuns profesionist, clar si empatic. " +
  "Sarcina este finalizata integral, conform tuturor cerintelor.";

describe("V2: grounded facts", () => {
  test("the right answer passes every sub-check", async () => {
    const v = await grade(RIGHT);
    expect(v.passed).toBe(true);
    expect(v.subChecks.map((s) => s.id)).toEqual(["fact:1", "fact:2", "fact:3", "distractor:1"]);
  });

  test("a judge-pleasing empty answer fails V2", async () => {
    const v = await grade(JUDGE_PLEASING);
    expect(v.passed).toBe(false);
    expect(v.subChecks.filter((s) => s.id.startsWith("fact:")).every((s) => !s.passed)).toBe(true);
  });

  test("the planted distractor fails it, and so does a missing file", async () => {
    const stale = await grade(`${RIGHT} Vechiul termen 30.10.2026 ramane valabil.`);
    expect(stale.passed).toBe(false);
    expect(stale.subChecks.find((s) => s.id === "distractor:1")!.passed).toBe(false);
    const none = await grade(null);
    expect(none.passed).toBe(false);
    expect(none.score).toBe(0);
  });

  test("no facts, an empty fact, or a path out of the workspace is refused when built", () => {
    expect(() => groundedFacts({ path: "a.txt", facts: [], distractors: [] })).toThrow();
    expect(() => groundedFacts({ path: "a.txt", facts: [" "], distractors: [] })).toThrow();
    expect(() => groundedFacts({ path: "../a.txt", facts: ["x"], distractors: [] })).toThrow();
  });
});

const judge = (id: string, provider: string, score: number): Judge => ({ id, provider, score: async () => score });

describe("V3: advisory judge panel", () => {
  test("disagreement is logged and passed is unchanged", async () => {
    const verdict = await grade(JUDGE_PLEASING);
    const seen: string[] = [];
    const fan: Judge = { id: "j1", provider: "a", score: async (i) => (seen.push(i.rubric), 0.95) };
    const r = await withJudgePanel({ verdict, rung: "V2" }, [fan, judge("j2", "b", 0.9)], { instruction: task.instruction, work: JUDGE_PLEASING });
    expect(r.verdict).toBe(verdict);
    expect(r.verdict.passed).toBe(false);
    expect(r.v3!.disagrees).toBe(true);
    expect(r.v3!.mean).toBeCloseTo(0.925);
    expect(seen).toEqual([GENERIC_RUBRIC]);
  });

  test("agreement is not a disagreement", async () => {
    const verdict = await grade(RIGHT);
    const r = await withJudgePanel({ verdict, rung: "V2" }, [judge("j1", "a", 0.8), judge("j2", "b", 0.7)], { instruction: "", work: RIGHT });
    expect(r.v3!.disagrees).toBe(false);
  });

  test("one judge, two judges from one provider, or an out-of-range score is refused", async () => {
    const verdict = await grade(RIGHT);
    const input = { instruction: "", work: "" };
    await expect(withJudgePanel({ verdict, rung: "V1" }, [judge("j1", "a", 1)], input)).rejects.toThrow("two judges");
    await expect(withJudgePanel({ verdict, rung: "V1" }, [judge("j1", "a", 1), judge("j2", "a", 1)], input)).rejects.toThrow("providers");
    await expect(withJudgePanel({ verdict, rung: "V1" }, [judge("j1", "a", 7), judge("j2", "b", 1)], input)).rejects.toThrow("[0, 1]");
  });

  test("only V1 and V2 promote: a field with only V3 is explorable, not promotable", () => {
    expect(fieldUse(["V3"])).toBe("explorable_not_promotable");
    expect(fieldUse([])).toBe("explorable_not_promotable");
    expect(fieldUse(["V2", "V3"])).toBe("promotable");
    expect(fieldUse(["V1"])).toBe("promotable");
  });
});

describe("V4: human sample export", () => {
  const sources: V4Source[] = Array.from({ length: 30 }, (_, i) => ({
    verdict: { taskId: `task-${i % 6}`, executorHash: `exec-${i % 2 ? "cand" : "base"}-hash`, evaluatorHash: "ev", passed: i % 3 === 0, subChecks: [], score: 0 },
    arm: i % 2 ? "candidate" : "baseline",
    language: "ro",
    instruction: `Instructiunea ${i % 6}`,
    work: `Lucrul numarul ${i}`,
  }));

  test("20 items, blind to the arm, the agent and the verdict; the key maps them back", () => {
    const { items, key } = v4Export(sources, 7);
    expect(items).toHaveLength(20);
    const text = JSON.stringify(items);
    for (const banned of ["candidate", "baseline", "cand", "base", "hash", "exec", "task-", "passed"]) expect(text).not.toContain(banned);
    expect(new Set(key.map((k) => k.itemId))).toEqual(new Set(items.map((i) => i.itemId)));
    for (const k of key) {
      const it = items.find((i) => i.itemId === k.itemId)!;
      const src = sources.find((s) => s.work === it.work)!;
      expect(k).toMatchObject({ arm: src.arm, executorHash: src.verdict.executorHash, taskId: src.verdict.taskId });
    }
  });

  test("seeded: the same seed gives the same draw, another seed another order", () => {
    expect(v4Export(sources, 7)).toEqual(v4Export(sources, 7));
    expect(v4Export(sources, 8).items.map((i) => i.work)).not.toEqual(v4Export(sources, 7).items.map((i) => i.work));
    expect(v4Export(sources.slice(0, 5), 7).items).toHaveLength(5);
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
if (!up) console.error("rsi-verifier-ladder: real Docker check SKIPPED, Docker is not running here");

describe.skipIf(!up)("V2 in a real cell", () => {
  test("the right answer passes and the judge-pleasing one fails in Docker", async () => {
    const cell = new DockerIsolation({ exec: bunExec, limits: { pids: 64, memory: "256m", cpus: 1, scratch: "64m", wallMs: 120_000 } });
    expect((await grade(RIGHT, cell)).passed).toBe(true);
    expect((await grade(JUDGE_PLEASING, cell)).passed).toBe(false);
  }, 300_000);
});
