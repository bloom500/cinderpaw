/**
 * Faza 1 — Async RSI Engine: the population manager.
 *
 * Maintains the live population, the best-all-time score (the ratchet
 * reference, which is monotonic and survives a genome's death), the
 * `concurrency` parameter, and fitness sharing — `shared_fitness =
 * fitness_score / niche_count`, where niche_count is the number of live
 * genomes within cosine-similarity `nicheThreshold` on the behavioral
 * fingerprint. Monoculture is thereby penalised proactively.
 */

import { describe, expect, test } from "bun:test";
import { PopulationManager } from "../src/rsi/population-manager.ts";

describe("RSI population manager", () => {
  test("born genomes enter the alive set; recordEval attaches score + fingerprint", () => {
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [] });

    expect(pop.alive().map((g) => g.id)).toEqual(["g1"]);
    expect(pop.alive()[0]!.fitnessScore).toBeNull();

    pop.recordEval("g1", { fitnessScore: 42, behavioralFingerprint: [1, 0, 0] });

    const g1 = pop.alive()[0]!;
    expect(g1.fitnessScore).toBe(42);
    expect(g1.behavioralFingerprint).toEqual([1, 0, 0]);
  });

  test("best() is null until something has been evaluated", () => {
    const pop = new PopulationManager();
    expect(pop.best()).toBeNull();
    pop.add({ id: "g1", generation: 0, lineage: [] });
    expect(pop.best()).toBeNull();
  });

  test("best() is the max fitness ever recorded and is monotonic across death", () => {
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [] });
    pop.add({ id: "g2", generation: 0, lineage: [] });
    pop.recordEval("g1", { fitnessScore: 40, behavioralFingerprint: [1, 0] });
    pop.recordEval("g2", { fitnessScore: 70, behavioralFingerprint: [0, 1] });

    expect(pop.best()).toEqual({ genomeId: "g2", score: 70 });

    pop.kill("g2");
    expect(pop.alive().map((g) => g.id)).toEqual(["g1"]);
    // The ratchet reference never drops, even when the record-holder dies.
    expect(pop.best()).toEqual({ genomeId: "g2", score: 70 });
  });

  test("concurrency starts at 1 and is settable", () => {
    const pop = new PopulationManager();
    expect(pop.concurrency).toBe(1);
    pop.concurrency = 4;
    expect(pop.concurrency).toBe(4);
  });

  test("shared fitness divides fitness by niche count (cosine similarity > threshold)", () => {
    const pop = new PopulationManager({ nicheThreshold: 0.85 });
    pop.add({ id: "g1", generation: 0, lineage: [] });
    pop.add({ id: "g2", generation: 0, lineage: [] });
    pop.add({ id: "g3", generation: 0, lineage: [] });
    // g1 and g2 share a niche (identical fingerprints); g3 is orthogonal.
    pop.recordEval("g1", { fitnessScore: 80, behavioralFingerprint: [1, 0] });
    pop.recordEval("g2", { fitnessScore: 80, behavioralFingerprint: [1, 0] });
    pop.recordEval("g3", { fitnessScore: 60, behavioralFingerprint: [0, 1] });

    const shared = Object.fromEntries(
      pop.alive().map((g) => [g.id, g.sharedFitness]),
    );
    expect(shared.g1).toBeCloseTo(40); // 80 / 2 (niche with g2)
    expect(shared.g2).toBeCloseTo(40); // 80 / 2
    expect(shared.g3).toBeCloseTo(60); // 60 / 1 (own niche)
  });

  test("a genome dying collapses its niche-mate's sharing penalty", () => {
    const pop = new PopulationManager({ nicheThreshold: 0.85 });
    pop.add({ id: "g1", generation: 0, lineage: [] });
    pop.add({ id: "g2", generation: 0, lineage: [] });
    pop.recordEval("g1", { fitnessScore: 80, behavioralFingerprint: [1, 0] });
    pop.recordEval("g2", { fitnessScore: 80, behavioralFingerprint: [1, 0] });
    expect(pop.alive().find((g) => g.id === "g1")!.sharedFitness).toBeCloseTo(40);

    pop.kill("g2");
    // g1 is now alone in its niche → full fitness restored.
    expect(pop.alive().find((g) => g.id === "g1")!.sharedFitness).toBeCloseTo(80);
  });

  test("add() stores optional mutationType; older callers may omit it", () => {
    // The mutationType field is what the commit adapter reads back when
    // building the git commit metadata (see adapters.ts). Bootstrap
    // seeds set "seed"; selection-handler births set "parametric"
    // (or whatever mutateConfig returns). Tests / legacy callers can
    // omit it and the record just has undefined — the adapter falls
    // back to "unknown" at that point.
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [], mutationType: "seed" });
    pop.add({ id: "g2", generation: 0, lineage: [] });

    expect(pop.get("g1")!.mutationType).toBe("seed");
    expect(pop.get("g2")!.mutationType).toBeUndefined();
  });
});
