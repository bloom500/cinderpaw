/**
 * Faza 3 — Fractal Search: escape-time recorder handler.
 *
 * `EscapeTimeRecorder` subscribes to EvalComplete and feeds an
 * `EscapeTimeTracker` with the per-region escape-time of the lineage
 * that just finished evaluating. The region is keyed on the PARENT's
 * config (the mutation was applied within the parent's region), and
 * the score chain is walked in birth order through `lineage[0]`.
 *
 * These tests verify:
 *   - a single EvalComplete records into the parent's region;
 *   - the full lineage chain (multi-generation) is walked in birth
 *     order, and the chain's escape-time is what gets recorded;
 *   - bootstrap seeds (no lineage) are no-ops;
 *   - missing parents and unevaluated ancestors terminate the walk
 *     gracefully;
 *   - the same tracker can be plugged into the selection handler via
 *     SelectionDeps.escapeTracker and immediately influences the
 *     mutation zoom factor (end-to-end contract).
 */

import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/rsi/infra/event-bus.ts";
import {
  EscapeTimeTracker,
  regionKey,
} from "../src/rsi/l1-config/escape-time.ts";
import { EscapeTimeRecorder } from "../src/rsi/l1-config/escape-time-recorder.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import { createRsiEngine } from "../src/rsi/engine.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

const CFG_A: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.2,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 0,
};

const CFG_B: GenomeConfig = {
  ...CFG_A,
  temperature: 0.8, // different region
  retrievalStrategy: "semantic",
};

function makePop(): PopulationManager {
  return new PopulationManager();
}

describe("EscapeTimeRecorder", () => {
  test("records an escape-time into the parent's region on EvalComplete", () => {
    const bus = new EventBus();
    const pop = makePop();
    const tracker = new EscapeTimeTracker();
    pop.add({
      id: "p",
      generation: 0,
      lineage: [],
      config: CFG_A,
    });
    pop.recordEval("p", { fitnessScore: 50, behavioralFingerprint: [1] });
    pop.add({
      id: "c",
      generation: 1,
      lineage: ["p"],
      config: { ...CFG_A, temperature: 0.21 }, // same region as parent
    });
    new EscapeTimeRecorder(bus, pop, tracker);

    bus.emit({
      type: "EvalComplete",
      genomeId: "c",
      score: 80, // chain [50, 80] → escapeTime=1
      behavioralFingerprint: [1],
      tokenCost: 100,
      durationMs: 10,
      errored: false,
    });

    const region = regionKey(CFG_A);
    expect(tracker.meanEscapeTime(region)).toBe(1);
  });

  test("the chain is walked in birth order — newest score last", () => {
    const bus = new EventBus();
    const pop = makePop();
    const tracker = new EscapeTimeTracker();
    pop.add({ id: "g0", generation: 0, lineage: [], config: CFG_A });
    pop.recordEval("g0", { fitnessScore: 30, behavioralFingerprint: [1] });
    pop.add({ id: "g1", generation: 1, lineage: ["g0"], config: CFG_A });
    pop.recordEval("g1", { fitnessScore: 50, behavioralFingerprint: [1] });
    pop.add({ id: "g2", generation: 2, lineage: ["g1"], config: CFG_A });
    pop.recordEval("g2", { fitnessScore: 60, behavioralFingerprint: [1] });
    pop.add({ id: "g3", generation: 3, lineage: ["g2"], config: CFG_A });
    new EscapeTimeRecorder(bus, pop, tracker);

    bus.emit({
      type: "EvalComplete",
      genomeId: "g3",
      score: 90, // chain [30, 50, 60, 90] → escapeTime=3 (strictly improving)
      behavioralFingerprint: [1],
      tokenCost: 100,
      durationMs: 10,
      errored: false,
    });

    const region = regionKey(CFG_A);
    expect(tracker.meanEscapeTime(region)).toBe(3);
  });

  test("chain stops at the first unevaluated ancestor", () => {
    const bus = new EventBus();
    const pop = makePop();
    const tracker = new EscapeTimeTracker();
    pop.add({ id: "g0", generation: 0, lineage: [], config: CFG_A });
    // g0 is NOT evaluated — chain begins empty.
    pop.add({ id: "g1", generation: 1, lineage: ["g0"], config: CFG_A });
    pop.recordEval("g1", { fitnessScore: 50, behavioralFingerprint: [1] });
    pop.add({ id: "g2", generation: 2, lineage: ["g1"], config: CFG_A });
    new EscapeTimeRecorder(bus, pop, tracker);

    bus.emit({
      type: "EvalComplete",
      genomeId: "g2",
      score: 60, // chain [] (g0 unevaluated) + [50] + [60] = [50, 60] → escapeTime=1
      behavioralFingerprint: [1],
      tokenCost: 100,
      durationMs: 10,
      errored: false,
    });

    const region = regionKey(CFG_A);
    expect(tracker.meanEscapeTime(region)).toBe(1);
  });

  test("bootstrap seed (no lineage) is a no-op", () => {
    const bus = new EventBus();
    const pop = makePop();
    const tracker = new EscapeTimeTracker();
    pop.add({ id: "seed", generation: 0, lineage: [], config: CFG_A });
    new EscapeTimeRecorder(bus, pop, tracker);

    bus.emit({
      type: "EvalComplete",
      genomeId: "seed",
      score: 42,
      behavioralFingerprint: [1],
      tokenCost: 100,
      durationMs: 10,
      errored: false,
    });

    // Nothing recorded — mean over unseen regions is 0.
    expect(tracker.meanEscapeTime(regionKey(CFG_A))).toBe(0);
  });

  test("missing parent in population is a no-op (defensive)", () => {
    const bus = new EventBus();
    const pop = makePop();
    const tracker = new EscapeTimeTracker();
    pop.add({
      id: "orphan",
      generation: 1,
      lineage: ["ghost"],
      config: CFG_A,
    });
    new EscapeTimeRecorder(bus, pop, tracker);

    bus.emit({
      type: "EvalComplete",
      genomeId: "orphan",
      score: 50,
      behavioralFingerprint: [1],
      tokenCost: 100,
      durationMs: 10,
      errored: false,
    });

    expect(tracker.meanEscapeTime(regionKey(CFG_A))).toBe(0);
  });

  test("a lineage cycle does not infinite-loop", async () => {
    const bus = new EventBus();
    const pop = makePop();
    const tracker = new EscapeTimeTracker();
    // Manually poke a cycle into the population.
    pop.add({ id: "a", generation: 0, lineage: ["b"], config: CFG_A });
    pop.add({ id: "b", generation: 0, lineage: ["a"], config: CFG_A });
    pop.recordEval("a", { fitnessScore: 10, behavioralFingerprint: [1] });
    pop.recordEval("b", { fitnessScore: 20, behavioralFingerprint: [1] });
    new EscapeTimeRecorder(bus, pop, tracker);

    // Should not hang — the cycle is detected and broken.
    await bus.emit({
      type: "EvalComplete",
      genomeId: "a",
      score: 30, // chain [20, 30] → escapeTime=1
      behavioralFingerprint: [1],
      tokenCost: 100,
      durationMs: 10,
      errored: false,
    });

    // `expect(true).toBe(true)` used to stand here. It cannot fail: if the walk
    // hangs, the test times out (which is a real signal), but if the walk
    // returns something WRONG the test still passes — so the assertion covered
    // only half of what the title claims.
    //
    // The cycle a→b→a must be broken AND the escape time recorded from the
    // truncated chain, not left unmeasured.
    const mean = tracker.meanEscapeTime(regionKey(CFG_A));
    expect(Number.isFinite(mean)).toBe(true);
    expect(mean).toBeGreaterThan(0);
  });

  test("end-to-end: tracker wired via SelectionDeps.escapeTracker influences the zoom factor", async () => {
    // Long escape-time region → zoom factor < 1 → finer mutations.
    // We can't easily assert "mutation magnitude" without a real RNG
    // inspection, but we CAN assert that the tracker accumulates
    // observations as the engine runs.
    const pop = new PopulationManager({ concurrency: 1 });
    const tracker = new EscapeTimeTracker();
    let si = 0;
    const engine = createRsiEngine({
      seeds: [
        { id: "seed", generation: 0, lineage: [], config: CFG_A },
      ],
      goal: { goal: "x", maxIterations: 4, maxTotalTokens: 1e9 },
      evalDeps: {
        runEval: async () => [
          { taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false },
        ],
        scoreGenome: async () => ({ score: [40, 50, 60, 70][si++] ?? 70 }),
      },
      ratchetDeps: {
        commitGenome: async () => ({ commitHash: "x".repeat(40) }),
        ratchetAttempt: async () => ({ advanced: true, previousBest: 0 }),
      },
      selection: {
        // capacity > 1 so the selection handler is allowed to birth a
        // child after the seed is evaluated (a seed's EvalComplete
        // triggers a birth because alive=1 < capacity=2).
        capacity: 2,
        bounds: {
          templatePoolSize: 1,
          systemPromptPoolSize: 1,
          maxTemperature: 1.0,
          temperatureSigma: 0.2,
          contextWindowSigma: 0.1,
          transferEpsilon: 0.1,
        },
        rng: () => 0.0,
        gaussian: () => 0,
        newId: () => `g${si}`,
        escapeTracker: tracker,
      },
    });
    // Inject the recorder AFTER createRsiEngine — the engine already
    // wired recorder → ratchet → selection, so adding EscapeTimeRecorder
    // here places it last in the EvalComplete cascade. That's fine
    // because the population recorder (which sets fitnessScore) runs
    // first; by the time our handler runs the score is visible.
    new EscapeTimeRecorder(engine.bus, engine.pop, tracker);

    await engine.run();

    // After 4 evals: eval#1 is the seed (no parent, no-op), evals
    // #2-4 are children/grandchildren of the seed and SHOULD record
    // into CFG_A's region. We expect at least one observation.
    const regionA = regionKey(CFG_A);
    expect(tracker.meanEscapeTime(regionA)).toBeGreaterThan(0);
  });
});
