/**
 * Faza 2 — Extinction: who gets culled.
 *
 * `selectForExtinction` decides WHICH live genomes an extinction event
 * kills (the handler decides WHEN). Per PLAN.md it kills 80% of the live
 * *candidates*, where candidates exclude the Hall of Fame (which already
 * contains main / best-all-time) and the top-N elite by shared fitness.
 * The lowest-shared-fitness candidates die first; unevaluated genomes
 * (null shared fitness) are the most expendable.
 */

import { describe, expect, test } from "bun:test";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";

/** Add a genome and give it a fingerprint + score so it has shared fitness. */
function seed(pop: PopulationManager, id: string, score: number) {
  pop.add({ id, generation: 0, lineage: [] });
  // unique fingerprint per genome → niche_count 1 → sharedFitness == score
  pop.recordEval(id, {
    fitnessScore: score,
    behavioralFingerprint: uniqueVec(id),
  });
}

let n = 0;
function uniqueVec(_id: string): number[] {
  const v = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  v[n++ % v.length] = 1;
  return v;
}

describe("PopulationManager.selectForExtinction", () => {
  test("kills 80% of the candidate pool, lowest shared fitness first", () => {
    const pop = new PopulationManager();
    // 10 genomes, scores 100..10 recorded highest-first so ONLY g10
    // (the best-all-time) is auto-inducted to the Hall of Fame.
    for (let i = 10; i >= 1; i--) seed(pop, `g${i}`, i * 10);
    // HoF = {g10}. eliteCount default 1 → protect top non-HoF (g9).
    // candidates = g1..g8 (8). kill floor(0.8*8) = 6 lowest → g1..g6.
    const killed = pop.selectForExtinction();
    expect(killed.sort()).toEqual(["g1", "g2", "g3", "g4", "g5", "g6"]);
  });

  test("never selects a Hall-of-Fame genome", () => {
    const pop = new PopulationManager();
    for (let i = 5; i >= 1; i--) seed(pop, `g${i}`, i * 10); // g5 best → HoF
    pop.induct("g1"); // protect the weakest manually (Tier 2 breakthrough)
    const killed = pop.selectForExtinction({ eliteCount: 0 });
    expect(killed).not.toContain("g1");
    expect(killed).not.toContain("g5"); // g5 is best-all-time → HoF
  });

  test("respects eliteCount (protect the strongest candidates)", () => {
    const pop = new PopulationManager();
    for (let i = 6; i >= 1; i--) seed(pop, `g${i}`, i * 10); // g6 best → HoF
    // HoF={g6}. eliteCount 2 → protect g5,g4. candidates=g1,g2,g3.
    // kill floor(0.8*3)=2 lowest → g1,g2.
    const killed = pop.selectForExtinction({ eliteCount: 2 }).sort();
    expect(killed).toEqual(["g1", "g2"]);
  });

  test("unevaluated genomes are the most expendable", () => {
    const pop = new PopulationManager();
    seed(pop, "g1", 90);
    seed(pop, "g2", 80);
    pop.add({ id: "g3", generation: 0, lineage: [] }); // no eval → null shared
    // HoF={g1}. eliteCount 0. candidates=g2,g3. kill floor(0.8*2)=1 lowest.
    // g3 (null) ranks below g2 → g3 dies.
    expect(pop.selectForExtinction({ eliteCount: 0 })).toEqual(["g3"]);
  });

  test("returns nothing when the candidate pool is empty", () => {
    const pop = new PopulationManager();
    seed(pop, "g1", 50); // sole genome → best → HoF
    expect(pop.selectForExtinction()).toEqual([]);
  });
});
