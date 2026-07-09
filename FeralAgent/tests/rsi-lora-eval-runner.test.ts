/**
 * Faza 4 — LoRA eval runner: adapter swap ordering, restore-on-throw,
 * tier0 extraction, and outcome pairing.
 */

import { describe, expect, test } from "bun:test";
import type { EvalOutcome } from "../src/rsi/infra/eval-worker.ts";
import {
  makeLoraEvalRunner,
  pairOutcomes,
  tier0Of,
} from "../src/rsi/l2-adapt/lora-eval-runner.ts";
import type { GenomeSpec } from "../src/rsi/l1-config/population-manager.ts";

const GENOME = { id: "eval-identity" } as GenomeSpec;

function outcome(taskId: string, tier: number, success: boolean): EvalOutcome {
  return { taskId, tier, success, latencyMs: 10, tokens: 5, errored: false };
}

describe("tier0Of", () => {
  test("passes when every tier-0 task succeeds (other tiers may fail)", () => {
    expect(
      tier0Of([outcome("t0a", 0, true), outcome("t1a", 1, false)]),
    ).toEqual({ passed: true });
  });

  test("fails with the failing tier-0 ids", () => {
    expect(
      tier0Of([outcome("t0a", 0, false), outcome("t0b", 0, true), outcome("t0c", 0, false)]),
    ).toEqual({ passed: false, failedSpecIds: ["t0a", "t0c"] });
  });

  test("no tier-0 outcomes → passes (nothing regressed)", () => {
    expect(tier0Of([outcome("t1a", 1, false)])).toEqual({ passed: true });
  });
});

describe("pairOutcomes", () => {
  test("pairs by taskId as 0/1", () => {
    expect(
      pairOutcomes(
        [outcome("a", 1, true), outcome("b", 1, false)],
        [outcome("b", 1, true), outcome("a", 1, false)],
      ),
    ).toEqual([
      { candidate: 1, baseline: 0 },
      { candidate: 0, baseline: 1 },
    ]);
  });

  test("unpaired tasks are dropped from both sides", () => {
    expect(
      pairOutcomes(
        [outcome("a", 1, true), outcome("only-candidate", 1, true)],
        [outcome("a", 1, true), outcome("only-baseline", 1, true)],
      ),
    ).toHaveLength(1);
  });
});

describe("makeLoraEvalRunner", () => {
  function harness(opts: { baseline?: string | null; candidateThrows?: boolean } = {}) {
    const setCalls: Array<string | null> = [];
    const evalRuns: Array<string | null> = []; // adapter active per run
    let active: string | null = null;
    const runner = makeLoraEvalRunner({
      setLora: async (p) => {
        setCalls.push(p);
        active = p;
      },
      runEval: async (genome) => {
        expect(genome.id).toBe("eval-identity");
        evalRuns.push(active);
        if (opts.candidateThrows && active === "/adapters/cand.gguf") {
          throw new Error("model crashed under candidate");
        }
        // Baseline fails task b; candidate passes everything.
        const winning = active === "/adapters/cand.gguf";
        return [
          outcome("t0", 0, true),
          outcome("a", 1, true),
          outcome("b", 1, winning),
        ];
      },
      genome: GENOME,
      baselineAdapterPath: () => opts.baseline ?? null,
    });
    return { runner, setCalls, evalRuns };
  }

  test("swap order: baseline → candidate → restore baseline", async () => {
    const { runner, setCalls, evalRuns } = harness({ baseline: "/adapters/champ.gguf" });
    const r = await runner("/adapters/cand.gguf");
    expect(setCalls).toEqual([
      "/adapters/champ.gguf",
      "/adapters/cand.gguf",
      "/adapters/champ.gguf",
    ]);
    expect(evalRuns).toEqual(["/adapters/champ.gguf", "/adapters/cand.gguf"]);
    expect(r.tier0.passed).toBe(true);
    // Task b: candidate 1 vs baseline 0; others tied.
    expect(r.samples).toEqual([
      { candidate: 1, baseline: 1 },
      { candidate: 1, baseline: 1 },
      { candidate: 1, baseline: 0 },
    ]);
  });

  test("no champion → baseline is the bare foundation model (null)", async () => {
    const { runner, setCalls } = harness({ baseline: null });
    await runner("/adapters/cand.gguf");
    expect(setCalls).toEqual([null, "/adapters/cand.gguf", null]);
  });

  test("candidate run throws → baseline restored, error propagates", async () => {
    const { runner, setCalls } = harness({
      baseline: "/adapters/champ.gguf",
      candidateThrows: true,
    });
    await expect(runner("/adapters/cand.gguf")).rejects.toThrow(/crashed under candidate/);
    // Restore still happened after the throw.
    expect(setCalls[setCalls.length - 1]).toBe("/adapters/champ.gguf");
  });
});
