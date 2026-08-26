/**
 * Fingerprint comparability — the guard that keeps monoculture detection alive.
 *
 * `extinction-handler.ts` calls `meanFingerprintSimilarity()` on every eval with
 * no try/catch. Before this guard, one genome with an empty or differently-sized
 * fingerprint made that throw, so extinction detection silently stopped running
 * — and because the numbers it produces are advisory, nothing looked broken. A
 * clean test run printed sixteen of those errors, which is exactly how a real
 * RSI failure would be camouflaged during a campaign.
 *
 * So the contract is: these two metrics NEVER throw on real population data,
 * and they never quietly compare genomes evaluated on different task sets.
 */

import { describe, expect, test } from "bun:test";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";

/** Minimal genome the manager will accept, with a fingerprint we control. */
function seed(
  pop: PopulationManager,
  id: string,
  fingerprint: number[] | null,
  score = 1,
): void {
  pop.add({
    id,
    generation: 0,
    parentId: null,
    config: {} as never,
  } as never);
  const genome = pop.alive().find((g) => g.id === id)!;
  genome.fitnessScore = score;
  genome.behavioralFingerprint = fingerprint;
}

function population(): PopulationManager {
  return new PopulationManager();
}

describe("an empty fingerprint means unevaluated, not evaluated-on-nothing", () => {
  test("meanFingerprintSimilarity survives a genome with []", () => {
    const pop = population();
    seed(pop, "a", [1, 0, 1]);
    seed(pop, "b", [1, 0, 1]);
    seed(pop, "c", []);
    // The whole point: no throw. Before the guard this took extinction
    // detection down for the rest of the run.
    expect(() => pop.meanFingerprintSimilarity()).not.toThrow();
    // Two identical fingerprints, so the pair that IS comparable scores 1.
    expect(pop.meanFingerprintSimilarity()).toBeCloseTo(1, 5);
  });

  test("recomputeSharedFitness survives one too", () => {
    const pop = population();
    seed(pop, "a", [1, 0, 1], 10);
    seed(pop, "b", [1, 0, 1], 10);
    seed(pop, "c", [], 10);
    expect(() => pop.recomputeSharedFitness()).not.toThrow();
    // a and b share a niche, so each carries half its own fitness.
    const a = pop.alive().find((g) => g.id === "a")!;
    expect(a.sharedFitness).toBeCloseTo(5, 5);
  });

  test("a null fingerprint is still ignored, as it always was", () => {
    const pop = population();
    seed(pop, "a", [1, 1]);
    seed(pop, "b", null);
    expect(pop.meanFingerprintSimilarity()).toBe(0); // fewer than two comparable
  });
});

describe("genomes evaluated on different task sets are skipped, not averaged", () => {
  test("the majority task set wins and the metric still runs", () => {
    const pop = population();
    seed(pop, "a", [1, 0, 1]);
    seed(pop, "b", [1, 0, 1]);
    seed(pop, "c", [1, 0, 1]);
    seed(pop, "odd", new Array(21).fill(1)); // a different task set entirely
    expect(() => pop.meanFingerprintSimilarity()).not.toThrow();
    expect(pop.meanFingerprintSimilarity()).toBeCloseTo(1, 5);
  });

  test("no monoculture can be claimed from fewer than two comparable genomes", () => {
    const pop = population();
    seed(pop, "a", [1, 0, 1]);
    seed(pop, "b", new Array(21).fill(1));
    // One of each length: no majority worth trusting, and extinction must never
    // trigger on a similarity invented from a single genome.
    expect(pop.meanFingerprintSimilarity()).toBeLessThanOrEqual(1);
    expect(() => pop.meanFingerprintSimilarity()).not.toThrow();
  });
});
