/**
 * Faza 2 — NEAT-Speciation Crossover: candidate selection.
 *
 * `selectCrossoverPairs` finds the genome pairs worth crossing
 * (PLAN.md "NEAT-Speciation Crossover"): pairs that BOTH
 *   - share a recent common ancestor (git LCA — injected, wraps the
 *     bridge `rsi_lca` in production); this relatedness gate is what
 *     prevents destructive crossover between completely different regions
 *     of the search space; AND
 *   - have divergent behavioral fingerprints (cosine similarity below
 *     `divergenceThreshold`), so crossing them actually mixes behaviours
 *     rather than producing a near-clone.
 * Each returned pair is ordered fitter-first (so the fitter parent's
 * categorical genes win in `crossoverConfigs`), and pairs are ranked by
 * combined fitness so the caller can take the strongest.
 */

import { describe, expect, test } from "bun:test";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import { selectCrossoverPairs } from "../src/rsi/l1-config/crossover-selection.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.5,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
};

function seed(
  pop: PopulationManager,
  id: string,
  score: number,
  fingerprint: number[],
) {
  pop.add({ id, generation: 1, lineage: [], config: CFG });
  pop.recordEval(id, { fitnessScore: score, behavioralFingerprint: fingerprint });
}

describe("selectCrossoverPairs", () => {
  test("selects related + divergent pairs, fitter first", async () => {
    const pop = new PopulationManager();
    seed(pop, "a", 80, [1, 0]); // divergent from b (cos 0)
    seed(pop, "b", 40, [0, 1]);
    const related = new Set(["a|b"]);
    const pairs = await selectCrossoverPairs(pop, {
      hasRecentCommonAncestor: (x, y) =>
        related.has([x, y].sort().join("|")),
      divergenceThreshold: 0.85,
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.fitter.id).toBe("a"); // higher score
    expect(pairs[0]!.other.id).toBe("b");
  });

  test("excludes pairs without a recent common ancestor", async () => {
    const pop = new PopulationManager();
    seed(pop, "a", 80, [1, 0]);
    seed(pop, "b", 40, [0, 1]);
    const pairs = await selectCrossoverPairs(pop, {
      hasRecentCommonAncestor: () => false, // unrelated → destructive, skip
    });
    expect(pairs).toEqual([]);
  });

  test("excludes pairs whose fingerprints are too similar", async () => {
    const pop = new PopulationManager();
    seed(pop, "a", 80, [1, 1]); // same direction → cos 1 → not divergent
    seed(pop, "b", 40, [2, 2]);
    const pairs = await selectCrossoverPairs(pop, {
      hasRecentCommonAncestor: () => true,
      divergenceThreshold: 0.85,
    });
    expect(pairs).toEqual([]);
  });

  test("ignores genomes that are unevaluated or have no config", async () => {
    const pop = new PopulationManager();
    seed(pop, "a", 80, [1, 0]);
    pop.add({ id: "b", generation: 1, lineage: [], config: CFG }); // unevaluated
    pop.add({ id: "c", generation: 1, lineage: [] }); // no config + unevaluated
    const pairs = await selectCrossoverPairs(pop, {
      hasRecentCommonAncestor: () => true,
    });
    expect(pairs).toEqual([]); // only "a" is eligible → no pair
  });

  test("ranks pairs by combined fitness (strongest first)", async () => {
    const pop = new PopulationManager();
    seed(pop, "a", 90, [1, 0]);
    seed(pop, "b", 80, [0, 1]);
    seed(pop, "c", 10, [1, 0.1]);
    seed(pop, "d", 5, [0.1, 1]);
    const pairs = await selectCrossoverPairs(pop, {
      hasRecentCommonAncestor: () => true,
      divergenceThreshold: 0.85,
    });
    // strongest combined pair (a+b = 170) ranks first
    expect(pairs[0]!.fitter.id).toBe("a");
    expect(pairs[0]!.other.id).toBe("b");
  });
});
