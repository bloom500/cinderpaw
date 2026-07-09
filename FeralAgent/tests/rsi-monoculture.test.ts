/**
 * Faza 2 — Extinction: the monoculture detector.
 *
 * `meanFingerprintSimilarity()` is the population-diversity metric that
 * drives the adaptive extinction trigger (PLAN.md "Extinction"): the
 * mean pairwise cosine similarity of the behavioral fingerprints of all
 * live, evaluated genomes. A value above 0.85 means the population has
 * converged on one behaviour (monoculture) and is a candidate for an
 * extinction event. Fewer than two evaluated genomes → 0 (no
 * monoculture is possible, so never trigger).
 */

import { describe, expect, test } from "bun:test";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";

const ev = (
  pop: PopulationManager,
  id: string,
  fingerprint: number[],
) => {
  pop.add({ id, generation: 0, lineage: [] });
  pop.recordEval(id, { fitnessScore: 50, behavioralFingerprint: fingerprint });
};

describe("PopulationManager.meanFingerprintSimilarity", () => {
  test("returns 0 with fewer than two evaluated genomes", () => {
    const pop = new PopulationManager();
    expect(pop.meanFingerprintSimilarity()).toBe(0);
    ev(pop, "g1", [1, 0, 0]);
    expect(pop.meanFingerprintSimilarity()).toBe(0);
  });

  test("identical fingerprints give similarity 1 (full monoculture)", () => {
    const pop = new PopulationManager();
    ev(pop, "g1", [1, 1, 0]);
    ev(pop, "g2", [2, 2, 0]); // same direction, different magnitude
    ev(pop, "g3", [3, 3, 0]);
    expect(pop.meanFingerprintSimilarity()).toBeCloseTo(1, 10);
  });

  test("orthogonal fingerprints give similarity 0 (max diversity)", () => {
    const pop = new PopulationManager();
    ev(pop, "g1", [1, 0]);
    ev(pop, "g2", [0, 1]);
    expect(pop.meanFingerprintSimilarity()).toBeCloseTo(0, 10);
  });

  test("averages over unique pairs, not self-pairs", () => {
    const pop = new PopulationManager();
    ev(pop, "g1", [1, 0]); // cos(g1,g2)=0, cos(g1,g3)=1, cos(g2,g3)=0
    ev(pop, "g2", [0, 1]);
    ev(pop, "g3", [2, 0]);
    // mean of {0, 1, 0} = 1/3
    expect(pop.meanFingerprintSimilarity()).toBeCloseTo(1 / 3, 10);
  });

  test("ignores dead and unevaluated genomes", () => {
    const pop = new PopulationManager();
    ev(pop, "g1", [1, 0]);
    ev(pop, "g2", [1, 0]);
    pop.add({ id: "g3", generation: 0, lineage: [] }); // unevaluated
    ev(pop, "g4", [0, 1]);
    pop.kill("g4"); // dead — excluded
    // only g1,g2 remain evaluated+alive → similarity 1
    expect(pop.meanFingerprintSimilarity()).toBeCloseTo(1, 10);
  });
});
