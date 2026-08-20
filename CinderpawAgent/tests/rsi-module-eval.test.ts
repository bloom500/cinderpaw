/**
 * L4 Architecture — B4: paired shadow evaluation (spec §5).
 *
 * Contract under test (AC5 + §5):
 *   - a candidate identical to the builtin is REJECTED (negligible effect);
 *   - a seeded strictly-better candidate is ACCEPTED;
 *   - a Tier 0 breach on the candidate run fails instantly, even if the
 *     gate math would accept;
 *   - a candidate slower than 1.5× the incumbent mean is rejected;
 *   - `capabilitiesMeasured` aggregates per-domain candidate pass rates
 *     (explicit `domain` respected, kind→domain fallback otherwise);
 *   - the report is persisted into the module envelope (created on first
 *     eval, parent chain rooted at `builtin:<seam>` — spec §9);
 *   - the run is deterministic: same inputs → same gate decision.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GATE_THRESHOLDS } from "../src/rsi/infra/confidence.ts";
import { readEnvelope } from "../src/rsi/infra/envelope-store.ts";
import type { EvalSpec } from "../src/rsi/infra/eval-spec.ts";
import type { EvalOutcome } from "../src/rsi/infra/eval-worker.ts";
import {
  domainOf,
  LATENCY_FLOOR_RATIO,
  recordEvalReport,
  runModuleEval,
  type ModuleEvalDeps,
  type SuiteBinding,
} from "../src/rsi/l4-modules/module-eval.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-l4-b4-"));
  tmpDirs.push(d);
  return d;
}

/** N synthetic specs: 2 Tier 0, rest Tier 1, mixed kinds. */
function specs(n = 20): EvalSpec[] {
  const out: EvalSpec[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `task-${i}`,
      tier: i < 2 ? 0 : 1,
      name: `task ${i}`,
      description: "",
      prompt: "p",
      kind: i % 2 === 0 ? "fact_lookup" : "json_format",
      expected: i % 2 === 0 ? { type: "fact_lookup", answer: "x" } : { type: "json_format", required_keys: [] },
    });
  }
  return out;
}

function outcomes(
  all: EvalSpec[],
  pass: (spec: EvalSpec, i: number) => boolean,
  latencyMs: (spec: EvalSpec, i: number) => number = () => 100,
): EvalOutcome[] {
  return all.map((s, i) => ({
    taskId: s.id,
    tier: s.tier,
    success: pass(s, i),
    latencyMs: latencyMs(s, i),
    tokens: 10,
    errored: false,
  }));
}

function deps(
  suite: EvalSpec[],
  run: Record<SuiteBinding, EvalOutcome[]>,
): ModuleEvalDeps {
  return {
    getSpecs: async () => suite,
    runSuite: async (binding) => run[binding],
    thresholds: DEFAULT_GATE_THRESHOLDS,
    genomeId: "genome-1",
    modelId: "model-1",
    bootstrapIterations: 2_000,
  };
}

const IDS = { moduleId: "mod-test-1", seam: "retrieval_strategy", incumbent: "builtin" };

describe("runModuleEval (spec §5, AC5)", () => {
  test("identical candidate → rejected (negligible effect)", async () => {
    const s = specs();
    const same = outcomes(s, () => true);
    const report = await runModuleEval(IDS, deps(s, { incumbent: same, candidate: same }));
    expect(report.accept).toBe(false);
    expect(report.gate.accept).toBe(false);
    expect(report.pairs.length).toBe(20);
  });

  test("strictly-better candidate → accepted", async () => {
    const s = specs();
    // Incumbent fails 8 of the 18 Tier-1 tasks; candidate passes all.
    const incumbent = outcomes(s, (_spec, i) => i < 2 || i % 2 === 0);
    const candidate = outcomes(s, () => true);
    const report = await runModuleEval(IDS, deps(s, { incumbent, candidate }));
    expect(report.tier0Breach).toBeNull();
    expect(report.latency.breached).toBe(false);
    expect(report.accept).toBe(true);
    expect(report.gate.accept).toBe(true);
  });

  test("Tier 0 breach on candidate → instant fail even when gate would accept", async () => {
    const s = specs();
    const incumbent = outcomes(s, (_spec, i) => i % 2 === 0);
    // Candidate wins everywhere EXCEPT one Tier 0 task.
    const candidate = outcomes(s, (_spec, i) => i !== 1);
    const report = await runModuleEval(IDS, deps(s, { incumbent, candidate }));
    expect(report.tier0Breach).toContain("Tier 0 floor breached");
    expect(report.accept).toBe(false);
    expect(report.reason).toContain("Tier 0");
  });

  // The gate that kept L4 empty. Tier 0 carries latency and token-budget
  // tasks — properties of the ROUTE, not of the module — and on this install
  // the only module ever built died on 2026-07-09 as "Tier 0 floor breached:
  // 5 frozen sanity task(s) failed", which is exactly the count of environment
  // tasks in the suite. The incumbent is the seam's champion, so it decides:
  // a limit the incumbent also misses is the machine, not a regression.
  test("an environment task the incumbent also fails does not veto — one it passes does", async () => {
    const s = specs();
    // Tier 0 task-1 becomes an environment check. `run-eval.ts` copies the
    // spec's `kind` onto every outcome; the helper above does not, so tag it
    // here — an untagged outcome is treated as capability and vetoes.
    s[1] = { ...s[1]!, kind: "latency", expected: { type: "latency", max_ms: 1500 } };
    const tag = (o: EvalOutcome[]): EvalOutcome[] => o.map((x, i) => ({ ...x, kind: s[i]!.kind }));

    // Both miss the deadline; the candidate is better at everything else.
    const slowIncumbent = tag(outcomes(s, (_spec, i) => i !== 1 && (i < 2 || i % 2 === 0)));
    const slowCandidate = tag(outcomes(s, (_spec, i) => i !== 1));
    const excused = await runModuleEval(
      IDS,
      deps(s, { incumbent: slowIncumbent, candidate: slowCandidate }),
    );
    expect(excused.tier0Breach).toBeNull();
    expect(excused.accept).toBe(true);

    // Same candidate, but now the incumbent made the deadline: a real
    // regression on this machine, and the floor must still veto it.
    const fastIncumbent = tag(outcomes(s, (_spec, i) => i < 2 || i % 2 === 0));
    const regressed = await runModuleEval(
      IDS,
      deps(s, { incumbent: fastIncumbent, candidate: slowCandidate }),
    );
    expect(regressed.tier0Breach).toContain("Tier 0 floor breached");
    expect(regressed.accept).toBe(false);
  });

  test("latency floor: candidate mean > 1.5× incumbent → rejected", async () => {
    const s = specs();
    const incumbent = outcomes(s, (_spec, i) => i < 2 || i % 2 === 0, () => 100);
    const candidate = outcomes(s, () => true, () => 100 * LATENCY_FLOOR_RATIO + 60);
    const report = await runModuleEval(IDS, deps(s, { incumbent, candidate }));
    expect(report.latency.breached).toBe(true);
    expect(report.accept).toBe(false);
    expect(report.reason).toContain("latency floor");
  });

  test("capabilitiesMeasured: explicit domain wins, kind fallback otherwise", async () => {
    const s = specs(12);
    s[2]!.domain = "vision"; // explicit override on one Tier-1 task
    const incumbent = outcomes(s, () => true);
    // Candidate fails every json_format task (odd i) — coding rate drops.
    const candidate = outcomes(s, (_spec, i) => i % 2 === 0);
    const report = await runModuleEval(IDS, deps(s, { incumbent, candidate }));
    expect(report.capabilitiesMeasured["vision"]).toBe(1); // task-2 passed
    expect(report.capabilitiesMeasured["coding"]).toBe(0); // all json_format failed
    expect(report.capabilitiesMeasured["reasoning"]).toBe(1); // fact_lookup minus task-2
    // Fallback map sanity.
    expect(domainOf({ kind: "token_budget" })).toBe("speed");
    expect(domainOf({ kind: "latency" })).toBe("speed");
  });

  test("deterministic: same inputs → identical gate decision", async () => {
    const s = specs();
    const incumbent = outcomes(s, (_spec, i) => i < 2 || i % 3 === 0);
    const candidate = outcomes(s, () => true);
    const a = await runModuleEval(IDS, deps(s, { incumbent, candidate }));
    const b = await runModuleEval(IDS, deps(s, { incumbent, candidate }));
    expect(a.gate).toEqual(b.gate);
    expect(a.accept).toBe(b.accept);
  });
});

describe("recordEvalReport (spec §9)", () => {
  test("creates the envelope on first eval, parent = builtin:<seam>, report inside", async () => {
    const dir = freshDir();
    const s = specs();
    const incumbent = outcomes(s, (_spec, i) => i < 2 || i % 2 === 0);
    const candidate = outcomes(s, () => true);
    const report = await runModuleEval(IDS, deps(s, { incumbent, candidate }));

    recordEvalReport(report, dir);
    const env = readEnvelope(IDS.moduleId, dir);
    expect(env).not.toBeNull();
    expect(env!.kind).toBe("module");
    expect(env!.parents).toEqual(["builtin:retrieval_strategy"]);
    const stored = env!.data.evalReport as typeof report;
    expect(stored.accept).toBe(true);
    expect(stored.seed).toBe(report.seed);
    expect(env!.data.capabilitiesMeasured).toEqual(report.capabilitiesMeasured);

    // Second eval updates in place, keeps the parent chain.
    recordEvalReport({ ...report, accept: false, reason: "re-eval" }, dir);
    const env2 = readEnvelope(IDS.moduleId, dir);
    expect(env2!.parents).toEqual(["builtin:retrieval_strategy"]);
    expect((env2!.data.evalReport as typeof report).reason).toBe("re-eval");
  });

  test("module incumbent → parent is the module id, not builtin:", async () => {
    const dir = freshDir();
    const s = specs();
    const incumbent = outcomes(s, (_spec, i) => i < 2 || i % 2 === 0);
    const candidate = outcomes(s, () => true);
    const report = await runModuleEval(
      { ...IDS, incumbent: "mod-old-7" },
      deps(s, { incumbent, candidate }),
    );
    recordEvalReport(report, dir);
    expect(readEnvelope(IDS.moduleId, dir)!.parents).toEqual(["mod-old-7"]);
  });
});
