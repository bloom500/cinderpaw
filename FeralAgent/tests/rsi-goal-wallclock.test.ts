/**
 * Dream Cycle — GoalMode wall-clock episode cap.
 *
 * An episode must be bounded in time so it "cannot hang" and can't burn
 * tokens past its window. The cap is checked against an injectable clock
 * (config.now) so the test is deterministic — no real timers. When the
 * deadline (startedAt + maxWallClockMs) is reached, the run stops with
 * the new StopReason "WallClockExhausted", draining in-flight evals.
 */

import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/rsi/infra/event-bus.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import { EvalWorker } from "../src/rsi/infra/eval-worker.ts";
import { GoalMode, attachPopulationRecorder, type GoalConfig } from "../src/rsi/l1-config/goal-mode.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.7,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
};

/** Engine with a controllable clock; each completed eval advances the
 *  clock by `bumpMs`, so wall-clock time is deterministic. */
function buildTimed(opts: { config: GoalConfig; seeds: number; bumpMs: number; clock: { t: number } }) {
  const bus = new EventBus();
  const pop = new PopulationManager();
  for (let i = 0; i < opts.seeds; i++) {
    pop.add({ id: `seed-${i}`, generation: 0, lineage: [], config: CFG });
  }
  const evalWorker = new EvalWorker(bus, {
    runEval: async () => {
      opts.clock.t += opts.bumpMs;
      return [{ taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false }];
    },
    scoreGenome: async () => ({ score: 50 }),
  });
  attachPopulationRecorder(bus, pop);
  const gm = new GoalMode(bus, pop, evalWorker, opts.config);
  return { gm };
}

describe("GoalMode wall-clock cap", () => {
  test("stops with WallClockExhausted once the deadline is reached", async () => {
    const clock = { t: 0 };
    const { gm } = buildTimed({
      seeds: 10,
      bumpMs: 60,
      clock,
      config: {
        goal: "x",
        maxIterations: 1000,
        maxTotalTokens: 1e9,
        maxWallClockMs: 100,
        now: () => clock.t,
      },
    });
    const res = await gm.run();
    expect(res.reason).toBe("WallClockExhausted");
    // eval1 → t=60 (60<100, continue); eval2 → t=120 (>=100, stop).
    expect(res.iterations).toBe(2);
  });

  test("no wall-clock cap when maxWallClockMs is unset (back-compat)", async () => {
    const clock = { t: 0 };
    const { gm } = buildTimed({
      seeds: 3,
      bumpMs: 10_000,
      clock,
      config: { goal: "x", maxIterations: 3, maxTotalTokens: 1e9, now: () => clock.t },
    });
    const res = await gm.run();
    // Without a wall-clock cap, it runs to MaxIterations regardless of the clock.
    expect(res.reason).toBe("MaxIterations");
    expect(res.iterations).toBe(3);
  });
});
