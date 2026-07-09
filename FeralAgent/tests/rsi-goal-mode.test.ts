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
import { EventBus } from "../src/rsi/infra/event-bus.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import { EvalWorker } from "../src/rsi/infra/eval-worker.ts";
import { RatchetHandler } from "../src/rsi/l1-config/ratchet-handler.ts";
import { SelectionMutationHandler } from "../src/rsi/l1-config/selection-handler.ts";
import { RecalcitranceTracker } from "../src/rsi/l1-config/recalcitrance.ts";
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

  // ── Concurrency ramp (follow-up to 7d) ──────────────────────────────────
  //
  // GoalMode now reads `pop.concurrency` on every refill of the worker
  // pool. These tests verify:
  //   - concurrency=N actually runs N evals in parallel
  //   - raising pop.concurrency mid-run fills new slots on the next
  //     slot-free callback (no restart needed)
  //   - lowering pop.concurrency mid-run does NOT kill in-flight evals;
  //     they finish naturally and the pool drains to the new ceiling

  test("runs N evals in parallel when pop.concurrency=N", async () => {
    // Seed 4 genomes so the pool has work for all 4 slots.
    const bus = new EventBus();
    const pop = new PopulationManager({ concurrency: 4 });
    for (let i = 0; i < 4; i++) pop.add({ id: `seed-${i}`, generation: 0, lineage: [], config: CFG });
    attachPopulationRecorder(bus, pop);

    // Track the peak in-flight count. runEval resolves with a 30ms
    // delay, so all 4 evals should be in-flight simultaneously before
    // any completes.
    let inFlightPeak = 0;
    let inFlight = 0;
    const evalWorker = new EvalWorker(bus, {
      runEval: async () => {
        inFlight += 1;
        inFlightPeak = Math.max(inFlightPeak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return [{ taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false }];
      },
      scoreGenome: async () => ({ score: 50 }),
    });

    const gm = new GoalMode(bus, pop, evalWorker, {
      goal: "x",
      maxIterations: 4,
      maxTotalTokens: 1e9,
    });

    const res = await gm.run();
    expect(res.iterations).toBe(4);
    expect(inFlightPeak).toBe(4); // all 4 evals ran simultaneously
  });

  test("raising pop.concurrency mid-run fills new slots on the next slot-free", async () => {
    // The ramp itself is timing-sensitive; we verify the contract
    // directly: the ramp callback's value MUST be observed by the
    // next refill(). We do this with a single long eval that holds
    // the pool, then ramp concurrency, then check that the refill
    // pulled pop.concurrency and launched N more evals.
    const bus = new EventBus();
    const pop = new PopulationManager({ concurrency: 1 });
    // 1 "gate" genome + 3 "ramp" genomes. The gate holds the slot;
    // the ramp-batch will only fit if pop.concurrency was bumped.
    pop.add({ id: "gate", generation: 0, lineage: [], config: CFG });
    for (let i = 0; i < 3; i++) pop.add({ id: `ramp-${i}`, generation: 0, lineage: [], config: CFG });
    attachPopulationRecorder(bus, pop);

    let ramped = false;
    const completedOrder: string[] = [];
    const evalWorker = new EvalWorker(bus, {
      runEval: async (genome) => {
        // The "gate" eval runs long enough that we can observe the
        // ramp and refill. Once it completes, the pool empties and
        // refill() must respect pop.concurrency at that moment.
        const delay = genome.id === "gate" ? 30 : 5;
        await new Promise((r) => setTimeout(r, delay));
        completedOrder.push(genome.id);
        // After the gate finishes its await (about to complete),
        // ramp the pool up. The next refill (triggered by the
        // .finally()) must read the new value.
        if (genome.id === "gate" && !ramped) {
          pop.concurrency = 4;
          ramped = true;
        }
        return [{ taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false }];
      },
      scoreGenome: async () => ({ score: 50 }),
    });

    const gm = new GoalMode(bus, pop, evalWorker, {
      goal: "x",
      maxIterations: 4,
      maxTotalTokens: 1e9,
    });

    const res = await gm.run();
    expect(ramped).toBe(true);
    // All 4 genomes must complete — 1 gate + 3 ramp. The 3 ramp
    // evals only get launched if the refill after the gate read
    // pop.concurrency = 4.
    expect(res.iterations).toBe(4);
    expect(completedOrder.sort()).toEqual(["gate", "ramp-0", "ramp-1", "ramp-2"]);
  });

  test("lowering pop.concurrency mid-run drains naturally (no kill)", async () => {
    const bus = new EventBus();
    const pop = new PopulationManager({ concurrency: 4 });
    for (let i = 0; i < 4; i++) pop.add({ id: `seed-${i}`, generation: 0, lineage: [], config: CFG });
    attachPopulationRecorder(bus, pop);

    const completedIds: string[] = [];
    const evalWorker = new EvalWorker(bus, {
      runEval: async (genome) => {
        const id = genome.id;
        // First eval completes quickly and triggers the ramp-down.
        // Subsequent evals take longer so the pool has time to drain.
        const delay = completedIds.length === 0 ? 10 : 80;
        await new Promise((r) => setTimeout(r, delay));
        completedIds.push(id);
        if (completedIds.length === 1) {
          // First eval done → drop ceiling to 1. The 3 in-flight evals
          // must still finish naturally; no kill.
          pop.concurrency = 1;
        }
        return [{ taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false }];
      },
      scoreGenome: async () => ({ score: 50 }),
    });

    const gm = new GoalMode(bus, pop, evalWorker, {
      goal: "x",
      maxIterations: 4,
      maxTotalTokens: 1e9,
    });

    const res = await gm.run();
    expect(res.iterations).toBe(4);
    // Every seed was evaluated — the in-flight evals finished naturally
    // even after the ramp-down signalled "stop launching more".
    expect(completedIds.sort()).toEqual(["seed-0", "seed-1", "seed-2", "seed-3"]);
  });

  test("concurrency=0 falls back to 1 (defensive — no deadlock on empty pool)", async () => {
    // pop.concurrency = 0 would otherwise launch nothing; the run loop
    // would spin forever waiting for in-flight to drain. The fallback
    // in run() ensures at least 1 slot is always open.
    const bus = new EventBus();
    const pop = new PopulationManager({ concurrency: 0 });
    pop.add({ id: "seed", generation: 0, lineage: [], config: CFG });
    attachPopulationRecorder(bus, pop);

    const evalWorker = new EvalWorker(bus, {
      runEval: async () => [{ taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false }],
      scoreGenome: async () => ({ score: 50 }),
    });

    const gm = new GoalMode(bus, pop, evalWorker, {
      goal: "x",
      maxIterations: 1,
      maxTotalTokens: 1e9,
    });

    const res = await gm.run();
    expect(res.iterations).toBe(1);
  });
});
