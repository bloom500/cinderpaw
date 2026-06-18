/**
 * Faza 1 — Async RSI Engine: Goal Mode orchestrator.
 *
 * The composition root. Wires the recorder + ratchet + selection +
 * recalcitrance handlers on one bus, drives evaluation at the population
 * `concurrency` (1 at start — the validated sequential mode), and runs
 * autonomously until a StopReason: TargetReached, BudgetExhausted,
 * MaxIterations, PlateauPersistent or UserStopped.
 *
 * Uses the real handlers (proving they compose); only the eval runner,
 * the scorer, and the git ops are fakes.
 */

import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/rsi/event-bus.ts";
import type { GenomeConfig } from "../src/rsi/genome.ts";
import { PopulationManager } from "../src/rsi/population-manager.ts";
import { EvalWorker } from "../src/rsi/eval-worker.ts";
import { RatchetHandler } from "../src/rsi/ratchet-handler.ts";
import { SelectionMutationHandler } from "../src/rsi/selection-handler.ts";
import { RecalcitranceTracker } from "../src/rsi/recalcitrance.ts";
import { GoalMode, attachPopulationRecorder, type GoalConfig } from "../src/rsi/goal-mode.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.7,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
};

const BOUNDS = {
  templatePoolSize: 5,
  systemPromptPoolSize: 5,
  maxTemperature: 1.0,
  temperatureSigma: 0.2,
  contextWindowSigma: 0.1,
  transferEpsilon: 0.1,
};

interface BuildOpts {
  scores: number[]; // score returned for each successive eval
  tokensPerEval?: number;
  config: GoalConfig;
}

function buildEngine(opts: BuildOpts) {
  const bus = new EventBus();
  const pop = new PopulationManager(); // concurrency defaults to 1
  pop.add({ id: "seed", generation: 0, lineage: [], config: CFG });

  let si = 0;
  const evalWorker = new EvalWorker(bus, {
    runEval: async () => [
      { taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: opts.tokensPerEval ?? 100, errored: false },
    ],
    scoreGenome: async () => ({ score: opts.scores[si++] ?? opts.scores[opts.scores.length - 1] ?? 0 }),
  });

  // Recorder MUST be the first EvalComplete subscriber so selection sees
  // the freshly-recorded shared fitness.
  attachPopulationRecorder(bus, pop);

  let gitBest = 0;
  new RatchetHandler(bus, {
    commitGenome: async () => ({ commitHash: "x".repeat(40) }),
    ratchetAttempt: async (_h, score) => {
      const previousBest = gitBest;
      const advanced = score > gitBest;
      if (advanced) gitBest = score;
      return { advanced, previousBest };
    },
  });

  let idN = 0;
  new SelectionMutationHandler(bus, pop, {
    capacity: 8,
    bounds: BOUNDS,
    rng: () => 0,
    gaussian: () => 0,
    newId: () => `g${++idN}`,
  });
  new RecalcitranceTracker(bus, {});

  const gm = new GoalMode(bus, pop, evalWorker, opts.config);
  return { bus, pop, gm };
}

describe("RSI Goal Mode", () => {
  test("stops with TargetReached once best beats the target", async () => {
    const { gm } = buildEngine({
      scores: [60, 75],
      config: { goal: "x", maxIterations: 10, maxTotalTokens: 1e9, targetScore: 70 },
    });
    const res = await gm.run();
    expect(res.reason).toBe("TargetReached");
    expect(res.iterations).toBe(2);
    expect(res.best?.score).toBe(75);
    expect(res.totalTokens).toBe(200);
  });

  test("stops with MaxIterations when the target is never met", async () => {
    const { gm } = buildEngine({
      scores: [50],
      config: { goal: "x", maxIterations: 3, maxTotalTokens: 1e9, targetScore: 90 },
    });
    const res = await gm.run();
    expect(res.reason).toBe("MaxIterations");
    expect(res.iterations).toBe(3);
  });

  test("stops with BudgetExhausted when tokens run out", async () => {
    const { gm } = buildEngine({
      scores: [50],
      tokensPerEval: 400,
      config: { goal: "x", maxIterations: 100, maxTotalTokens: 1000, targetScore: 99 },
    });
    const res = await gm.run();
    expect(res.reason).toBe("BudgetExhausted");
    // 3 evals = 1200 tokens crosses the 1000 budget.
    expect(res.iterations).toBe(3);
  });

  test("stops with PlateauPersistent after N iterations without improvement", async () => {
    const { gm } = buildEngine({
      scores: [50], // flat: best never improves after the first eval
      config: { goal: "x", maxIterations: 100, maxTotalTokens: 1e9, targetScore: 99, plateauPatience: 2 },
    });
    const res = await gm.run();
    expect(res.reason).toBe("PlateauPersistent");
    expect(res.iterations).toBe(3); // eval 1 sets best; evals 2 & 3 don't improve
  });

  test("stops with UserStopped when stop() is called mid-run", async () => {
    const { gm, bus } = buildEngine({
      scores: [50],
      config: { goal: "x", maxIterations: 100, maxTotalTokens: 1e9, targetScore: 99 },
    });
    // Request stop during the first eval's cascade.
    bus.on("EvalComplete", async () => gm.stop());
    const res = await gm.run();
    expect(res.reason).toBe("UserStopped");
    expect(res.iterations).toBe(1);
  });
});
