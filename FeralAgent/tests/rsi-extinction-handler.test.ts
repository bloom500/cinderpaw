/**
 * Faza 2 — Extinction: the handler that decides WHEN to cull.
 *
 * Subscribes to EvalComplete (the engine's natural cadence — the ratchet
 * fires there too). Two triggers, per PLAN.md "Extinction":
 *   - adaptive: mean fingerprint similarity > threshold (monoculture)
 *     AND a persistent plateau (no best-all-time gain for `plateauPatience`
 *     evals);
 *   - periodic fallback: every `periodicInterval` evals if the adaptive
 *     trigger hasn't fired.
 * On a trigger it emits ExtinctionTriggered, then a GenomeDied for each
 * culled genome (Hall of Fame survives). It tracks improvement itself via
 * `pop.best()` deltas, so it is independent of RatchetAdvanced ordering.
 */

import { describe, expect, test } from "bun:test";
import { EventBus, type RsiEvent } from "../src/rsi/infra/event-bus.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import { ExtinctionHandler } from "../src/rsi/l1-config/extinction-handler.ts";

/** Record ExtinctionTriggered + GenomeDied events for assertions. */
function recorder(bus: EventBus) {
  const events: RsiEvent[] = [];
  bus.on("ExtinctionTriggered", (e) => void events.push(e));
  bus.on("GenomeDied", (e) => void events.push(e));
  return events;
}

/** A converged (monoculture) population: identical fingerprints. */
function seedConverged(pop: PopulationManager, n: number) {
  // record highest first so only g1 is best-all-time → sole HoF member
  for (let i = n; i >= 1; i--) {
    pop.add({ id: `g${i}`, generation: 0, lineage: [] });
    pop.recordEval(`g${i}`, { fitnessScore: i, behavioralFingerprint: [1, 1] });
  }
}

describe("ExtinctionHandler", () => {
  test("adaptive trigger fires on monoculture + plateau and culls non-HoF", async () => {
    const bus = new EventBus();
    const pop = new PopulationManager();
    seedConverged(pop, 6); // similarity == 1
    const events = recorder(bus);
    new ExtinctionHandler(bus, pop, {
      monocultureThreshold: 0.85,
      plateauPatience: 2,
      periodicInterval: 1000, // disable periodic for this test
    });

    // No best improvement across these → plateau builds to 2.
    await bus.emit({ type: "EvalComplete", genomeId: "g2", score: 1 });
    expect(events).toHaveLength(0); // plateau not yet persistent
    await bus.emit({ type: "EvalComplete", genomeId: "g3", score: 1 });

    const triggered = events.filter((e) => e.type === "ExtinctionTriggered");
    const died = events.filter((e) => e.type === "GenomeDied");
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.reason).toBe("adaptive");
    expect(died.length).toBeGreaterThan(0);
    // best-all-time g6 (highest score) is in the Hall of Fame → never culled
    expect(died.map((e) => e.genomeId)).not.toContain("g6");
  });

  test("does not trigger when the population is diverse", async () => {
    const bus = new EventBus();
    const pop = new PopulationManager();
    // orthogonal fingerprints → similarity 0
    pop.add({ id: "a", generation: 0, lineage: [] });
    pop.recordEval("a", { fitnessScore: 9, behavioralFingerprint: [1, 0] });
    pop.add({ id: "b", generation: 0, lineage: [] });
    pop.recordEval("b", { fitnessScore: 1, behavioralFingerprint: [0, 1] });
    const events = recorder(bus);
    new ExtinctionHandler(bus, pop, { plateauPatience: 1, periodicInterval: 1000 });

    for (let i = 0; i < 5; i++) {
      await bus.emit({ type: "EvalComplete", genomeId: "b", score: 1 });
    }
    expect(events).toHaveLength(0);
  });

  test("does not trigger adaptive while still improving", async () => {
    const bus = new EventBus();
    const pop = new PopulationManager();
    seedConverged(pop, 4); // monoculture
    const events = recorder(bus);
    new ExtinctionHandler(bus, pop, { plateauPatience: 1, periodicInterval: 1000 });

    // Each EvalComplete coincides with a NEW best-all-time → no plateau.
    let best = 100;
    for (let i = 0; i < 4; i++) {
      pop.add({ id: `n${i}`, generation: 1, lineage: [] });
      pop.recordEval(`n${i}`, { fitnessScore: (best += 10), behavioralFingerprint: [1, 1] });
      await bus.emit({ type: "EvalComplete", genomeId: `n${i}`, score: best });
    }
    expect(events.filter((e) => e.type === "ExtinctionTriggered")).toHaveLength(0);
  });

  test("periodic fallback fires after periodicInterval evals", async () => {
    const bus = new EventBus();
    const pop = new PopulationManager();
    // diverse so adaptive never fires; periodic must still cull
    pop.add({ id: "x", generation: 0, lineage: [] });
    pop.recordEval("x", { fitnessScore: 9, behavioralFingerprint: [1, 0] });
    pop.add({ id: "y", generation: 0, lineage: [] });
    pop.recordEval("y", { fitnessScore: 5, behavioralFingerprint: [0, 1] });
    pop.add({ id: "z", generation: 0, lineage: [] });
    pop.recordEval("z", { fitnessScore: 1, behavioralFingerprint: [1, 1] });
    const events = recorder(bus);
    new ExtinctionHandler(bus, pop, {
      monocultureThreshold: 0.85,
      plateauPatience: 1000,
      periodicInterval: 3,
      eliteCount: 0,
    });

    for (let i = 0; i < 3; i++) {
      await bus.emit({ type: "EvalComplete", genomeId: "z", score: 1 });
    }
    const triggered = events.filter((e) => e.type === "ExtinctionTriggered");
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.reason).toBe("periodic");
  });
});
