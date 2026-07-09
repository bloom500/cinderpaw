/**
 * Faza 1 — runEval real: the suite runner.
 *
 * `makeRunEval` is the production `runEval` injected into the EvalWorker.
 * Given a genome it runs the agent over every spec (Tier 0 from Rust +
 * Tier 1/2 from disk), measures latency, trusts the router's token count,
 * validates each response deterministically, and returns one
 * `EvalOutcome` per task. The agent invocation is injected so the runner
 * is unit-testable without a model.
 *
 * Resilience contract: a single task that throws does NOT abort the
 * suite — it becomes an `errored: true`, `success: false` outcome so the
 * remaining tasks still run and the scorer sees the whole batch.
 */

import { describe, expect, test } from "bun:test";
import { makeRunEval } from "../src/rsi/infra/run-eval.ts";
import type { EvalSpec } from "../src/rsi/infra/eval-spec.ts";

const GENOME = { id: "g1", generation: 0, lineage: [] };

const factSpec: EvalSpec = {
  id: "tier1/capital",
  tier: 1,
  name: "Capital",
  description: "d",
  prompt: "Capital of France?",
  kind: "fact_lookup",
  expected: { type: "fact_lookup", answer: "paris" },
};

const budgetSpec: EvalSpec = {
  id: "tier1/budget",
  tier: 1,
  name: "Budget",
  description: "d",
  prompt: "Be brief.",
  kind: "token_budget",
  expected: { type: "token_budget", max_tokens: 100 },
};

describe("makeRunEval", () => {
  test("produces one passing outcome per correct response", async () => {
    const runEval = makeRunEval({
      getSpecs: async () => [factSpec],
      invokeAgent: async () => ({ response: "It is Paris.", tokens: 12 }),
      now: makeClock([0, 40]),
    });

    const outcomes = await runEval(GENOME);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      taskId: "tier1/capital",
      tier: 1,
      success: true,
      tokens: 12,
      latencyMs: 40,
      errored: false,
    });
  });

  test("marks a wrong response as a non-errored failure", async () => {
    const runEval = makeRunEval({
      getSpecs: async () => [factSpec],
      invokeAgent: async () => ({ response: "London", tokens: 5 }),
      now: makeClock([0, 10]),
    });
    const [o] = await runEval(GENOME);
    expect(o.success).toBe(false);
    expect(o.errored).toBe(false);
  });

  test("passes the spec prompt to the agent", async () => {
    const seen: string[] = [];
    const runEval = makeRunEval({
      getSpecs: async () => [factSpec],
      invokeAgent: async (prompt) => {
        seen.push(prompt);
        return { response: "paris", tokens: 1 };
      },
    });
    await runEval(GENOME);
    expect(seen).toEqual(["Capital of France?"]);
  });

  test("a thrown task becomes errored:false-success and the suite continues", async () => {
    const runEval = makeRunEval({
      getSpecs: async () => [factSpec, budgetSpec],
      invokeAgent: async (prompt) => {
        if (prompt === "Capital of France?") throw new Error("model OOM");
        return { response: "ok", tokens: 50 };
      },
    });
    const outcomes = await runEval(GENOME);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({
      taskId: "tier1/capital",
      success: false,
      errored: true,
      errorMessage: "model OOM",
    });
    expect(outcomes[1]).toMatchObject({ taskId: "tier1/budget", success: true, errored: false });
  });
});

/** Deterministic clock: returns the supplied timestamps in order. */
function makeClock(ts: number[]): () => number {
  let i = 0;
  return () => ts[Math.min(i++, ts.length - 1)]!;
}
