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

    // The child is now part of the live population, AND the
    // mutationType captured at birth is on the Genome record too —
    // the commit adapter reads it from there when it builds the git
    // metadata (see population-manager.test.ts). Without this, the
    // adapter has no way to know whether the genome was a bootstrap
    // seed or a selection-handler birth.
    expect(pop.alive().map((g) => g.id).sort()).toEqual(["child-1", "g1"]);
    expect(pop.get("child-1")!.mutationType).toBe("parametric");
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

describe("RSI selection — selection_pressure (PBT hyperparameter, Faza 3.5)", () => {
  // Two parents alone in their niches: g1=10 (weak), g2=90 (strong).
  // The same rng draw (0.05) must pick the WEAK parent under neutral
  // pressure but the STRONG one under high pressure — i.e. pressure
  // sharpens the roulette toward the fitter genome. Strategy-genomes own
  // this knob, so PBT can dial exploration↔exploitation of the Level-1
  // population without touching the metric.
  async function pressurePick(pressure: number | undefined): Promise<string> {
    const bus = new EventBus();
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [], config: CFG });
    pop.add({ id: "g2", generation: 0, lineage: [], config: CFG });
    pop.recordEval("g1", { fitnessScore: 10, behavioralFingerprint: [1, 0] });
    pop.recordEval("g2", { fitnessScore: 90, behavioralFingerprint: [0, 1] });
    const born: RsiEvent[] = [];
    bus.on("GenomeBorn", async (e) => born.push(e));
    new SelectionMutationHandler(bus, pop, {
      capacity: 8,
      bounds: BOUNDS,
      rng: seqRng([0.05]),
      gaussian: () => 0,
      newId: () => "child",
      ...(pressure != null ? { selectionPressure: () => pressure } : {}),
    });
    await bus.emit({ type: "EvalComplete", genomeId: "g2", score: 90, errored: false });
    return (born[0] as RsiEvent & { parentId: string }).parentId;
  }

  test("neutral pressure (1.0): r=5 < g1's band (10) → weak parent g1", async () => {
    expect(await pressurePick(1.0)).toBe("g1");
  });

  test("high pressure (3.0): weights^3 dwarf g1 → strong parent g2 for the same draw", async () => {
    expect(await pressurePick(3.0)).toBe("g2");
  });

  test("default (no selectionPressure dep) behaves like pressure 1.0", async () => {
    expect(await pressurePick(undefined)).toBe("g1");
  });
});
