/**
 * S1.10 of the AgentLoop evolution spec: the learnability band and the
 * novelty archive. Stub proposer model, stub classifier, a host cell that
 * runs the proposed check like the Docker cell would, a bag-of-words stub
 * embedder, and stub executor attempts with a fixed pass pattern.
 */
import { describe, expect, test } from "bun:test";
import type { CampaignManifest, CampaignResult } from "../src/rsi/infra/campaign.ts";
import type { IsolationBackend } from "../src/rsi/l3-code/isolation.ts";
import type { Classifier } from "../src/rsi/research/domain-gate.ts";
import type { TaskProposal } from "../src/rsi/research/feasibility.ts";
import { BUDGET } from "../src/rsi/research/families/build-repair.ts";
import { loadDefaultFieldData, type FieldTask } from "../src/rsi/research/field-sampler.ts";
import { explorationMetrics, renderReport, TECHNICAL_WORDS } from "../src/rsi/research/report.ts";
import { BudgetBroker, type BrokerModel } from "../src/rsi/research/task-budget.ts";
import { bandOf, proposeTask, TaskArchive, type Attempt, type Embedder } from "../src/rsi/research/task-proposer.ts";

const partitions = loadDefaultFieldData().partitions;
const dev = partitions.development[0]!;

const field = (taskId: string, code: string, family = dev): FieldTask => ({
  family,
  code,
  title: "Contabil",
  taskId,
  task: "Verifica facturile si calculeaza totalul de plata.",
  language: "ro",
});

const check = (file: string, want: string) =>
  `const fs=require("node:fs");const p=process.argv[1]+"/${file}";` +
  `process.exit(fs.existsSync(p)&&fs.readFileSync(p,"utf8").trim()==="${want}"?0:1);`;

const INVOICES: TaskProposal = {
  instruction: "Calculeaza totalul facturilor din facturi.csv si scrie-l in total.txt, cu doua zecimale.",
  files: { "facturi.csv": "furnizor,suma\nAlfa SRL,1000.00\nBeta SA,250.50\n" },
  check: check("total.txt", "1250.50"),
  solution: { "total.txt": "1250.50\n" },
  failures: [{ "total.txt": "1250\n" }, { "total.txt": "1000.00\n" }],
};

const SHIFTS: TaskProposal = {
  instruction: "Numara turele de noapte din ture.csv pentru asistenta Popescu si scrie numarul in noapte.txt.",
  files: { "ture.csv": "nume,tura\nPopescu,noapte\nIonescu,zi\nPopescu,zi\nPopescu,noapte\n" },
  check: check("noapte.txt", "2"),
  solution: { "noapte.txt": "2\n" },
  failures: [{ "noapte.txt": "3\n" }, { "noapte.txt": "1\n" }],
};

/** The proposer model, priced so the spend is visible in the metrics. */
function model(p: TaskProposal): BrokerModel {
  return {
    id: "proposer-model",
    usdPerMInput: 1,
    usdPerMOutput: 1,
    async call() {
      return { choices: [{ message: { content: JSON.stringify(p) } }], usage: { prompt_tokens: 500, completion_tokens: 500 } };
    },
  };
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

const budget = { maxInputTokens: 10_000, maxOutputTokens: 5_000, maxToolCalls: 5, maxWallMs: 60_000, maxUsd: 1 };

const propose = (p: TaskProposal, f: FieldTask) =>
  proposeTask({
    field: f,
    source: "onet",
    partitions,
    broker: new BudgetBroker(budget, model(p)),
    proposerModelId: "proposer-model",
    classifier: allow,
    cell: hostCell,
    budget: BUDGET,
  });

/** ponytail: bag of words hashed into 64 buckets; enough to tell a repeat from a different task. */
const embedder: Embedder = {
  id: "stub-bow-64",
  async embed(text) {
    const v = new Array<number>(64).fill(0);
    for (const w of text.toLowerCase().match(/[a-z0-9.]+/g) ?? []) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      v[h % 64]!++;
    }
    return v;
  },
};

/** Attempts that pass in the given pattern, at 0.01 $ each. */
const attempts = (pattern: boolean[]): Attempt => {
  let i = 0;
  return async () => ({ passed: pattern[i++ % pattern.length]!, usd: 0.01 });
};

describe("the learnability band (10%-90% of k tries)", () => {
  test("k = 3: 0 passes too hard, 1 or 2 learnable, 3 too easy", () => {
    expect([0, 1, 2, 3].map((p) => bandOf(p, 3))).toEqual(["too_hard", "learnable", "learnable", "too_easy"]);
    expect(() => bandOf(4, 3)).toThrow();
  });

  test("an always-solved task goes to too easy and earns the proposer nothing", async () => {
    const archive = new TaskArchive(embedder, partitions);
    const e = await archive.record(await propose(INVOICES, field("t1", "13-2011.00")), attempts([true]));
    expect(e.learnability).toMatchObject({ attempts: 3, passes: 3, band: "too_easy" });
    expect(e.novelty).toBe(1);
    expect(e.reward).toBe(0);
  });

  test("the reward never includes the pass rate: 1 of 3 and 2 of 3 are credited the same", async () => {
    const one = await new TaskArchive(embedder, partitions).record(await propose(INVOICES, field("t1", "c")), attempts([true, false, false]));
    const two = await new TaskArchive(embedder, partitions).record(await propose(INVOICES, field("t1", "c")), attempts([true, true, false]));
    expect(one.reward).toBe(1);
    expect(two.reward).toBe(one.reward);
  });

  test("the band is computed on development only: a holdout task never reaches the executor", async () => {
    const archive = new TaskArchive(embedder, partitions);
    const out = await propose(INVOICES, field("t1", "c"));
    const holdout = { ...out, receipt: { ...out.receipt, family: partitions.promotion[0]! } };
    let ran = 0;
    await expect(archive.record(holdout, async () => (ran++, { passed: true, usd: 0 }))).rejects.toThrow("development only");
    expect(ran).toBe(0);
    // And the proposer refuses a holdout field before any of it.
    const refused = await archive.record(await propose(INVOICES, field("t2", "c", partitions.promotion[0]!)), attempts([true]));
    expect(refused).toMatchObject({ receipt: { stage: "refused" }, novelty: 0, reward: 0 });
    expect(refused.learnability).toBeUndefined();
  });
});

describe("novelty", () => {
  test("a proposer repeating one task gets zero novelty credit", async () => {
    const archive = new TaskArchive(embedder, partitions);
    const learnable = attempts([true, false, false]);
    const first = await archive.record(await propose(INVOICES, field("t1", "a")), learnable);
    const again = await archive.record(await propose(INVOICES, field("t2", "b")), learnable);
    expect(first.reward).toBe(1);
    expect(again.novelty).toBeCloseTo(0, 9);
    expect(again.reward).toBeCloseTo(0, 9);
    const other = await archive.record(await propose(SHIFTS, field("t3", "c")), learnable);
    expect(other.novelty).toBeGreaterThan(0.3);
    expect(other.reward).toBe(other.novelty);
  });
});

describe("the report shows the four exploration metrics on a stub campaign", () => {
  test("coverage, novelty, learnable yield, cost per learnable task; Pentru Darius stays plain", async () => {
    const archive = new TaskArchive(embedder, partitions);
    await archive.record(await propose(INVOICES, field("t1", "13-2011.00")), attempts([true, false, false])); // learnable
    await archive.record(await propose(SHIFTS, field("t2", "29-1141.00")), attempts([true])); // too easy
    await archive.record(await propose(INVOICES, field("t3", "43-3031.00")), attempts([true, true, false])); // repeat, learnable
    await archive.record(await propose({ ...SHIFTS, check: "process.exit(0)" }, field("t4", "x")), attempts([true])); // infeasible

    const x = explorationMetrics(archive.entries);
    expect(x).toMatchObject({ proposals: 4, learnable: 2, yield: 0.5, occupations: 2, families: 1 });
    // 4 proposer calls of 1000 tokens at 1 $/M, plus 3 accepted tasks x 3 attempts x 0.01 $.
    expect(x.usd).toBeCloseTo(4 * 0.001 + 9 * 0.01, 9);
    expect(x.costPerLearnable).toBeCloseTo(x.usd / 2, 9);
    expect(x.meanNovelty!).toBeGreaterThan(0);
    expect(x.meanNovelty!).toBeLessThan(1);

    const manifest: CampaignManifest = {
      id: "s1-10-stub",
      seeds: [1],
      arms: ["base", "cand"],
      partitions: { development: [], promotion: [], final: [], transfer: [] },
      usdCap: 0,
      wallMsCap: 60_000,
    };
    const result: CampaignResult = { manifestHash: "m", samples: [], ledger: {}, matched: true, gate: { accept: false, reason: "stub" } as CampaignResult["gate"] };
    const md = renderReport({ manifest, result, runs: [], verdicts: [], startedBy: "Darius", startedAt: "2026-10-05T18:00", tier: "Micro", exploration: x });
    expect(md).toContain("- exploration: 4 proposals, learnable yield 0.500 (2), coverage 2 occupations / 1 families");
    expect(md).toContain("cost per learnable task");
    const darius = md.split("## Technical")[0]!;
    expect(darius).toContain("INT-2: Sarcini propuse de agent: 4; potrivite pentru invatat (nici prea usoare, nici prea grele): 2");
    expect(darius).toContain("INT-4: Meserii acoperite: 2, din 1 grupe de meserii");
    for (const w of TECHNICAL_WORDS) expect(darius).not.toMatch(new RegExp(`\\b${w}`, w === "RSI" ? "" : "i"));
  });
});
