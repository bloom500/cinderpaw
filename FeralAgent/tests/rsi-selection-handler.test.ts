/**
 * Faza 1 — Async RSI Engine: the selection/mutation handler.
 *
 * Reacts to EvalComplete and GenomeDied. When the live population has
 * room for a candidate, it selects a parent (fitness-proportionate on
 * shared_fitness), mutates its config (mutateConfig — parametric only in
 * Faza 1), adds the child to the population, and emits GenomeBorn.
 *
 * Capacity is a parameter (population_size is a PBT hyperparameter,
 * Faza 3.5). RNG / Gaussian / id generator are injected for determinism.
 */

import { describe, expect, test } from "bun:test";
import { EventBus, type RsiEvent } from "../src/rsi/event-bus.ts";
import type { GenomeConfig } from "../src/rsi/genome.ts";
import { PopulationManager } from "../src/rsi/population-manager.ts";
import { SelectionMutationHandler } from "../src/rsi/selection-handler.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.7,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
};

function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

const BOUNDS = {
  templatePoolSize: 5,
  systemPromptPoolSize: 5,
  maxTemperature: 1.0,
  temperatureSigma: 0.2,
  contextWindowSigma: 0.1,
  transferEpsilon: 0.1,
};

describe("RSI selection/mutation handler", () => {
  test("births a mutated child from the parent when there is room", async () => {
    const bus = new EventBus();
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [], config: CFG });
    pop.recordEval("g1", { fitnessScore: 50, behavioralFingerprint: [1, 0] });

    const born: RsiEvent[] = [];
    bus.on("GenomeBorn", async (e) => born.push(e));

    let n = 0;
    new SelectionMutationHandler(bus, pop, {
      capacity: 4,
      bounds: BOUNDS,
      // selection rng (0.0 → first candidate), then mutateConfig:
      // field idx 0.72→toolPreferenceWeights, transfer donor 0.0 recipient 0.3.
      rng: seqRng([0.0, 0.72, 0.0, 0.3]),
      gaussian: () => 0,
      newId: () => `child-${++n}`,
    });

    await bus.emit({ type: "EvalComplete", genomeId: "g1", score: 50, errored: false });

    expect(born.length).toBe(1);
    const e = born[0] as RsiEvent & {
      genomeId: string;
      parentId: string;
      generation: number;
      mutationType: string;
      config: GenomeConfig;
    };
    expect(e.genomeId).toBe("child-1");
    expect(e.parentId).toBe("g1");
    expect(e.generation).toBe(1);
    expect(e.mutationType).toBe("parametric");
    // Child carries a valid, mutated config.
    expect(e.config.toolPreferenceWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(e.config.toolPreferenceWeights).not.toEqual(CFG.toolPreferenceWeights);

    // The child is now part of the live population.
    expect(pop.alive().map((g) => g.id).sort()).toEqual(["child-1", "g1"]);
  });

  test("does not birth when the population is at capacity", async () => {
    const bus = new EventBus();
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [], config: CFG });
    pop.recordEval("g1", { fitnessScore: 50, behavioralFingerprint: [1, 0] });

    const born: RsiEvent[] = [];
    bus.on("GenomeBorn", async (e) => born.push(e));

    new SelectionMutationHandler(bus, pop, {
      capacity: 1, // already full
      bounds: BOUNDS,
      rng: seqRng([0.0, 0.72, 0.0, 0.3]),
      gaussian: () => 0,
      newId: () => "child-x",
    });

    await bus.emit({ type: "EvalComplete", genomeId: "g1", score: 50, errored: false });

    expect(born.length).toBe(0);
    expect(pop.alive().map((g) => g.id)).toEqual(["g1"]);
  });

  test("selection is fitness-proportionate on shared_fitness", async () => {
    const bus = new EventBus();
    const pop = new PopulationManager();
    // Orthogonal fingerprints → each alone in its niche → sharedFitness
    // equals fitnessScore: g1=20, g2=80, total=100.
    pop.add({ id: "g1", generation: 0, lineage: [], config: CFG });
    pop.add({ id: "g2", generation: 0, lineage: [], config: CFG });
    pop.recordEval("g1", { fitnessScore: 20, behavioralFingerprint: [1, 0] });
    pop.recordEval("g2", { fitnessScore: 80, behavioralFingerprint: [0, 1] });

    const born: RsiEvent[] = [];
    bus.on("GenomeBorn", async (e) => born.push(e));

    let n = 0;
    new SelectionMutationHandler(bus, pop, {
      capacity: 8,
      bounds: BOUNDS,
      // selection rng 0.9 → r=90 → skip g1 (20), land in g2's band (80).
      // then field idx 0.95→decompositionDepth, walk rng 0.9 → +1.
      rng: seqRng([0.9, 0.95, 0.9]),
      gaussian: () => 0,
      newId: () => `child-${++n}`,
    });

    await bus.emit({ type: "EvalComplete", genomeId: "g2", score: 80, errored: false });

    expect(born.length).toBe(1);
    expect((born[0] as RsiEvent & { parentId: string }).parentId).toBe("g2");
  });
});
