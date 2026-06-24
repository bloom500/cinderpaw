/**
 * Dream Cycle — full evolutionary continuity across sleeps.
 *
 * A dream cycle runs a bounded episode, then sleeps. To "respect the
 * genomes / lineage / extinction" across that sleep, the entire
 * PopulationManager state must round-trip: not just the best genome, but
 * the live + dead set, lineage, per-genome fitness/fingerprint, the
 * monotonic best-record, AND the path-dependent Hall of Fame (which a
 * public-API replay cannot reconstruct, because induction happens at the
 * running-best at each recordEval, not just the final max).
 */

import { describe, expect, test } from "bun:test";
import { PopulationManager } from "../src/rsi/population-manager.ts";

describe("PopulationManager snapshot/restore", () => {
  /** Build a population whose Hall of Fame is path-dependent: g1 becomes
   *  the running-best (inducted), then g2 overtakes it (inducted). Both
   *  end up immune even though only g2 is the final best — a plain replay
   *  by final state would miss g1. */
  function seeded(): PopulationManager {
    const pop = new PopulationManager({ nicheThreshold: 0.85 });
    pop.add({ id: "g1", generation: 0, lineage: [], mutationType: "seed" });
    pop.add({ id: "g2", generation: 1, lineage: ["g1"], mutationType: "parametric" });
    pop.add({ id: "g3", generation: 1, lineage: ["g1"], mutationType: "parametric" });
    pop.recordEval("g1", { fitnessScore: 40, behavioralFingerprint: [1, 0] }); // running best → HoF
    pop.recordEval("g2", { fitnessScore: 70, behavioralFingerprint: [0, 1] }); // new best → HoF
    pop.recordEval("g3", { fitnessScore: 30, behavioralFingerprint: [0, 1] });
    pop.kill("g3");
    pop.setCommitHash("g2", "abc123");
    pop.setCommitConfig("abc123", { temperature: 0.5 } as never);
    pop.concurrency = 3;
    return pop;
  }

  test("round-trips the live + dead set with fitness, lineage, and alive flags", () => {
    const snap = seeded().snapshot();
    const restored = new PopulationManager();
    restored.restore(snap);

    expect(restored.alive().map((g) => g.id).sort()).toEqual(["g1", "g2"]);
    expect(restored.get("g3")!.alive).toBe(false);
    expect(restored.get("g1")!.fitnessScore).toBe(40);
    expect(restored.get("g2")!.lineage).toEqual(["g1"]);
    expect(restored.get("g2")!.mutationType).toBe("parametric");
  });

  test("round-trips the monotonic best-record", () => {
    const restored = new PopulationManager();
    restored.restore(seeded().snapshot());
    expect(restored.best()).toEqual({ genomeId: "g2", score: 70 });
  });

  test("round-trips the path-dependent Hall of Fame (replay cannot)", () => {
    const restored = new PopulationManager();
    restored.restore(seeded().snapshot());
    // BOTH g1 (former running-best) and g2 (final best) must be immune.
    expect(restored.isImmune("g1")).toBe(true);
    expect(restored.isImmune("g2")).toBe(true);
    expect(restored.hallOfFame().sort()).toEqual(["g1", "g2"]);
  });

  test("round-trips commit hash + config maps", () => {
    const restored = new PopulationManager();
    restored.restore(seeded().snapshot());
    expect(restored.getCommitHash("g2")).toBe("abc123");
    expect(restored.getConfigByCommit("abc123")).toEqual({ temperature: 0.5 } as never);
  });

  test("restore preserves concurrency", () => {
    const restored = new PopulationManager();
    restored.restore(seeded().snapshot());
    expect(restored.concurrency).toBe(3);
  });

  test("a restored population keeps evolving correctly (extinction still respects immunity)", () => {
    const restored = new PopulationManager();
    restored.restore(seeded().snapshot());
    // g1 and g2 are immune (Hall of Fame); only non-immune live genomes
    // are extinction candidates. With g3 dead and g1/g2 immune, nothing
    // is killable — proving immunity survived the round-trip.
    expect(restored.selectForExtinction({ killFraction: 1, eliteCount: 0 })).toEqual([]);
  });
});
