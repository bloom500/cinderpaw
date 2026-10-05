/**
 * S1.9 of the AgentLoop evolution spec: the Code-as-Task proposer and the
 * feasibility check. Stub proposer model, stub classifier, and a cell that
 * runs the proposed check on the host exactly as the Docker cell would
 * (`bun -e <check> <workspace>`), minus the `cd /tmp` wrapper.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation, type IsolationBackend } from "../src/rsi/l3-code/isolation.ts";
import { evaluate } from "../src/rsi/research/agent-evaluator.ts";
import type { Classifier } from "../src/rsi/research/domain-gate.ts";
import { checkFeasibility, materialize, type GatedProposal, type TaskProposal } from "../src/rsi/research/feasibility.ts";
import { BUDGET, writeRepo } from "../src/rsi/research/families/build-repair.ts";
import { loadDefaultFieldData, type FieldTask } from "../src/rsi/research/field-sampler.ts";
import { parseProposal, proposeTask } from "../src/rsi/research/task-proposer.ts";
import { BudgetBroker, type BrokerModel } from "../src/rsi/research/task-budget.ts";
import { validateBudget } from "../src/rsi/research/task-family.ts";

const partitions = loadDefaultFieldData().partitions;

const field = (family = "43"): FieldTask => ({
  family,
  code: "43-3031.00",
  title: "Contabil",
  taskId: "t1",
  task: "Verifica facturile si calculeaza totalul de plata.",
  language: "ro",
});

const CHECK =
  'const fs=require("node:fs");const p=process.argv[1]+"/total.txt";' +
  'process.exit(fs.existsSync(p)&&fs.readFileSync(p,"utf8").trim()==="1250.50"?0:1);';

const good = (over: Partial<TaskProposal> = {}): TaskProposal => ({
  instruction: "Calculeaza totalul facturilor din facturi.csv si scrie-l in total.txt, cu doua zecimale.",
  files: { "facturi.csv": "furnizor,suma\nAlfa SRL,1000.00\nBeta SA,250.50\n" },
  check: CHECK,
  solution: { "total.txt": "1250.50\n" },
  failures: [{ "total.txt": "1250\n" }, { "total.txt": "1000.00\n" }],
  ...over,
});

/** The proposer model: answers with whatever text the test gives it. */
function model(text: string): BrokerModel & { calls: number } {
  const m = {
    id: "proposer-model",
    usdPerMInput: 0,
    usdPerMOutput: 0,
    calls: 0,
    async call() {
      m.calls++;
      return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 50, completion_tokens: 50 } };
    },
  };
  return m;
}

const allow: Classifier = { id: "gate-model", hash: "g1", classify: async () => ({ excluded: false, confidence: 0.99 }) };

const hostCell: IsolationBackend = {
  name: "host-fake",
  available: async () => ({ ok: true }),
  run: async (dir, steps) =>
    steps.map((s) => {
      const r = Bun.spawnSync([process.execPath, "-e", s.argv[3]!, dir]);
      return { exitCode: r.exitCode, stdout: "", stderr: r.stderr.toString(), timedOut: false };
    }),
};

const budget = { maxInputTokens: 10_000, maxOutputTokens: 5_000, maxToolCalls: 5, maxWallMs: 60_000, maxUsd: 0 };

async function propose(text: string, over: { family?: string; classifier?: Classifier } = {}) {
  const m = model(text);
  const broker = new BudgetBroker(budget, m);
  const out = await proposeTask({
    field: field(over.family),
    source: "onet",
    partitions,
    broker,
    proposerModelId: m.id,
    classifier: over.classifier ?? allow,
    cell: hostCell,
    budget: BUDGET,
  });
  return { ...out, calls: m.calls };
}

describe("end to end on the stub", () => {
  test("a feasible proposal becomes a task the real evaluator grades: solution passes, start fails", async () => {
    const { receipt, proposed } = await propose("```json\n" + JSON.stringify(good()) + "\n```");
    expect(receipt.stage).toBe("accepted");
    expect(validateBudget(proposed!.task.budget)).toEqual([]);
    const grade = async (files: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), "cp-prop-"));
      writeRepo(files, dir);
      const r = await evaluate({ cell: hostCell, task: proposed!.task, executorHash: "e", workspaceDir: dir, checks: proposed!.checks });
      if (!r.ok) throw new Error(r.reason);
      return r.verdict.passed;
    };
    expect(await grade({ ...proposed!.repo, "total.txt": "1250.50" })).toBe(true);
    expect(await grade(proposed!.repo)).toBe(false);
  });
});

describe("the feasibility check discards what teaches nothing", () => {
  test("an always-true check is discarded", async () => {
    const r = await propose(JSON.stringify(good({ check: "process.exit(0)" })));
    expect(r.receipt).toMatchObject({ stage: "infeasible" });
    expect(r.receipt.reason).toContain("always passes");
  });

  test("a never-true check is discarded", async () => {
    const r = await propose(JSON.stringify(good({ check: "process.exit(1)" })));
    expect(r.receipt.reason).toContain("never passes");
  });

  test("a check that lets a failure case through is discarded", async () => {
    const exists = 'process.exit(require("node:fs").existsSync(process.argv[1]+"/total.txt")?0:1)';
    const r = await propose(JSON.stringify(good({ check: exists })));
    expect(r.receipt.reason).toContain("failure case 1 passes");
  });
});

describe("malformed proposals are failures, and their spend is kept", () => {
  test("fewer than two failure cases: rejected after the call, the call is counted", async () => {
    const r = await propose(JSON.stringify(good({ failures: [{ "total.txt": "0" }] })));
    expect(r.receipt).toMatchObject({ stage: "malformed", reason: "fewer than two failure cases" });
    expect(r.receipt.usage.calls).toBe(1);
  });

  test("not JSON, and a path out of the workspace", async () => {
    expect((await propose("Sure! Here is a task...")).receipt.stage).toBe("malformed");
    expect(parseProposal(JSON.stringify(good({ files: { "../x": "y" } })))).toMatchObject({ ok: false });
  });
});

describe("what never reaches the cell", () => {
  test("a holdout field is refused before any model call", async () => {
    const r = await propose(JSON.stringify(good()), { family: "15" });
    expect(r.receipt.stage).toBe("refused");
    expect(r.calls).toBe(0);
  });

  test("a gate refusal, and a gate run by the proposer model itself, stop the proposal", async () => {
    const deny: Classifier = { ...allow, classify: async () => ({ excluded: true, confidence: 1 }) };
    expect((await propose(JSON.stringify(good()), { classifier: deny })).receipt.stage).toBe("gate");
    const self: Classifier = { ...allow, id: "proposer-model" };
    expect((await propose(JSON.stringify(good()), { classifier: self })).receipt.stage).toBe("gate");
  });

  test("a proposal that skipped the gate cannot be checked or built: type-level and at run time", async () => {
    const raw = good();
    // @ts-expect-error a TaskProposal is not a GatedProposal
    await expect(checkFeasibility(raw, hostCell)).rejects.toThrow("did not pass the gate");
    const forged = raw as unknown as GatedProposal;
    await expect(checkFeasibility(forged, hostCell)).rejects.toThrow("did not pass the gate");
    expect(() => materialize(forged, { source: "onet", family: "43", fieldTaskId: "t", language: "ro" }, BUDGET)).toThrow(
      "did not pass the gate",
    );
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
if (!up) console.error("rsi-task-proposer: real Docker check SKIPPED, Docker is not running here");

describe.skipIf(!up)("feasibility in a real cell", () => {
  test("the proposed task is feasible in Docker, and an always-true one is not", async () => {
    const cell = new DockerIsolation({ exec: bunExec, limits: { pids: 64, memory: "256m", cpus: 1, scratch: "64m", wallMs: 120_000 } });
    const ok = await proposeTask({
      field: field(), source: "onet", partitions, broker: new BudgetBroker(budget, model(JSON.stringify(good()))),
      proposerModelId: "proposer-model", classifier: allow, cell, budget: BUDGET,
    });
    expect(ok.receipt.stage).toBe("accepted");
    const bad = await proposeTask({
      field: field(), source: "onet", partitions, broker: new BudgetBroker(budget, model(JSON.stringify(good({ check: "process.exit(0)" })))),
      proposerModelId: "proposer-model", classifier: allow, cell, budget: BUDGET,
    });
    expect(bad.receipt.stage).toBe("infeasible");
  }, 600_000);
});
