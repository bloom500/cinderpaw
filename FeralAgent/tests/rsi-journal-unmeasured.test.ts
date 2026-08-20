/**
 * A journal row must say whether it measured anything.
 *
 * Two thirds of the rows in the real journal on this machine carry a fitness
 * vector that is 0.5 in every component — the "unmeasured" placeholder — and
 * were written in exactly the same shape as a row backed by a full eval
 * batch. Anyone reading the journal afterwards (a person, the RSI panel, an
 * agent asked "is evolution working?") counted them as evidence, because
 * nothing in the row said otherwise.
 */

import { describe, expect, it } from "bun:test";
import { contractLeavesFromRatchet, type CandidateContext } from "../src/rsi/infra/contract-leaves.ts";
import type { EvalOutcome } from "../src/rsi/infra/eval-worker.ts";

const deps = {
  commitGenome: async () => ({ commitHash: "abc123" }),
  ratchetAttempt: async () => ({ advanced: false, previousBest: 50 }),
};

const outcome = (taskId: string, success: boolean): EvalOutcome => ({
  taskId,
  tier: 0,
  success,
  latencyMs: 900,
  tokens: 120,
  errored: false,
  kind: "fact_lookup",
  answered: true,
});

const ctxWith = (extra: Partial<CandidateContext>): CandidateContext => ({
  genomeId: "g1",
  score: 50,
  tokenCost: 0,
  durationMs: 0,
  ...extra,
});

describe("journal honesty: unmeasured components are named", () => {
  it("flags every component when the candidate was never evaluated", async () => {
    const leaves = contractLeavesFromRatchet(deps, ctxWith({}), {});
    const out = await leaves.runBenchmark("g1");

    // The vector is all-neutral, which used to be indistinguishable from a
    // real 0.5 across the board.
    expect(Object.values(out.fitnessVector).every((v) => v === 0.5)).toBe(true);
    expect(out.unmeasured).toEqual(
      expect.arrayContaining([
        "accuracy",
        "latency",
        "cost",
        "toolSuccess",
        "hallucination",
        "userSatisfaction",
      ]),
    );
  });

  it("an empty outcome list counts as never evaluated, not as a perfect run", async () => {
    const leaves = contractLeavesFromRatchet(deps, ctxWith({ outcomes: [] }), {});
    const out = await leaves.runBenchmark("g1");
    expect(out.unmeasured).toContain("accuracy");
  });

  it("does not flag what it actually measured", async () => {
    const outcomes = [outcome("tier0/a", true), outcome("tier0/b", false)];
    const leaves = contractLeavesFromRatchet(deps, ctxWith({ score: 50, outcomes }), {});
    const out = await leaves.runBenchmark("g1");

    // accuracy/latency/cost come from a score with a real batch behind it.
    expect(out.unmeasured).not.toContain("accuracy");
    // hallucination IS measurable from fact tasks, so it is not flagged.
    expect(out.unmeasured).not.toContain("hallucination");
    // userSatisfaction still has no audit reader here — honestly flagged.
    expect(out.unmeasured).toContain("userSatisfaction");
  });
});
