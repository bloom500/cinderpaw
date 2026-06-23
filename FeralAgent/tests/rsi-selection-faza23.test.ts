/**
 * Runtime wiring — Faza 2/3 reproduction through the real handler.
 *
 * Proves the optional crossover / wild-explorer / taste deps on
 * SelectionMutationHandler actually change the births it emits (the
 * pure planBirth logic is unit-tested separately; here we verify the
 * handler resolves and forwards the inputs).
 */

import { describe, expect, test } from "bun:test";
import { EventBus, type RsiEvent } from "../src/rsi/event-bus.ts";
import { PopulationManager } from "../src/rsi/population-manager.ts";
import { SelectionMutationHandler } from "../src/rsi/selection-handler.ts";
import type { GenomeConfig } from "../src/rsi/genome.ts";

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

function setup(over: Record<string, unknown> = {}) {
  const bus = new EventBus();
  const pop = new PopulationManager();
  pop.add({ id: "a", generation: 0, lineage: [], config: { ...CFG, temperature: 0.8 } });
  pop.recordEval("a", { fitnessScore: 90, behavioralFingerprint: [1, 0] });
  pop.add({ id: "b", generation: 0, lineage: [], config: { ...CFG, temperature: 0.4 } });
  pop.recordEval("b", { fitnessScore: 40, behavioralFingerprint: [0, 1] });

  let idN = 0;
  const born: RsiEvent[] = [];
  bus.on("GenomeBorn", (e) => void born.push(e));
  new SelectionMutationHandler(bus, pop, {
    capacity: 8,
    bounds: BOUNDS,
    rng: () => 0,
    gaussian: () => 0,
    newId: () => `c${++idN}`,
    ...over,
  });
  return { bus, pop, born };
}

describe("SelectionMutationHandler — Faza 2/3 deps", () => {
  test("uses crossover when a candidate pair is available", async () => {
    const { bus, pop, born } = setup({
      crossover: {
        selectPairs: async () => [
          {
            fitter: { id: "a", generation: 0, config: { ...CFG, temperature: 0.8 } },
            other: { id: "b", generation: 0, config: { ...CFG, temperature: 0.4 } },
          },
        ],
      },
    });
    await bus.emit({ type: "EvalComplete", genomeId: "a", score: 90 });
    const crossover = born.find((e) => e.mutationType === "crossover");
    expect(crossover).toBeDefined();
    // lineage is recorded on the genome (read by the commit adapter)
    expect(pop.get(crossover!.genomeId as string)!.lineage).toEqual(["a", "b"]);
    // blended temperature is the mean of the two parents
    expect((crossover!.config as GenomeConfig).temperature).toBeCloseTo(0.6, 10);
  });

  test("labels a forced wild explorer", async () => {
    const { bus, born } = setup({
      wildExplorerRng: () => 0, // always < fraction → wild
    });
    await bus.emit({ type: "EvalComplete", genomeId: "a", score: 90 });
    expect(born[0]!.mutationType).toBe("wild");
    expect(born[0]!.wild).toBe(true);
  });

  test("applies the taste nudge to the child", async () => {
    const { bus, born } = setup({
      taste: { vector: () => [0.2, 0, 0, 0, 0, 0, 0], weight: () => 0.5 },
    });
    await bus.emit({ type: "EvalComplete", genomeId: "a", score: 90 });
    // parent "a" temperature 0.8; taste pushes +0.5*0.2=0.1 → clamps toward 0.9
    const cfg = born[0]!.config as GenomeConfig;
    expect(cfg.temperature).toBeGreaterThan(0.8);
  });
});
