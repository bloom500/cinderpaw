/**
 * Faza 3.5 — Meta-RSI via PBT: the pure strategy-genome controller.
 *
 * The controller owns a small population of strategy-genomes (the four
 * bootstrap seeds). Exactly one is "active" at a time — its
 * hyperparams steer the Level-1 search (population_size → capacity,
 * mutation_rate → grammar sigma scale, selection_pressure → roulette
 * sharpness, wild_explorer_pct → wildExplorerFraction). The active
 * strategy steers across the many EvalCompletes between two ratchets;
 * on each RatchetAdvanced it is credited with the improvement
 * (efficiency = scoreDelta / tokenCost), then a PBT exploit/explore
 * step replaces the worst strategy with a perturbed copy of a top
 * performer, and the active pointer rotates so every strategy gets a
 * tenure. Sync is event-driven (on RatchetAdvanced), never wall-clock.
 *
 * These tests inject a deterministic rng so the donor pick and the
 * perturbation are reproducible — no runtime, no model, no DB.
 */

import { describe, expect, test } from "bun:test";
import {
  PbtController,
  type StrategyGenome,
} from "../src/rsi/pbt-controller.ts";

/** Deterministic rng cycling through a fixed sequence in [0,1). */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

function hp(over: Partial<StrategyGenome["hyperparams"]> = {}): StrategyGenome["hyperparams"] {
  return {
    mutation_rate: 0.1,
    population_size: 16,
    selection_pressure: 1.0,
    zoom_policy: {
      coarse_threshold_high: 6,
      coarse_threshold_low: 2,
      fine_threshold_high: 10,
      fine_threshold_low: 2,
      wild_explorer_pct: 0.05,
    },
    ...over,
  };
}

function strat(id: string, over: Partial<StrategyGenome["hyperparams"]> = {}): StrategyGenome {
  return { id, hyperparams: hp(over), ratchetCount: 0, fitness: 0 };
}

function fourSeeds(): StrategyGenome[] {
  return [
    strat("s1", { mutation_rate: 0.05, population_size: 32 }),
    strat("s2", { mutation_rate: 0.1, population_size: 16 }),
    strat("s3", { mutation_rate: 0.25, population_size: 8 }),
    strat("s4", { mutation_rate: 0.4, population_size: 6 }),
  ];
}

describe("PbtController — active strategy + hyperparam exposure", () => {
  test("starts with the first strategy active and exposes its hyperparams", () => {
    const c = new PbtController({ strategies: fourSeeds(), rng: seqRng([0.5]) });
    expect(c.active().id).toBe("s1");
    expect(c.activeHyperparams().population_size).toBe(32);
  });

  test("activeHyperparams reflects the active strategy after rotation", () => {
    const c = new PbtController({ strategies: fourSeeds(), rng: seqRng([0.5]) });
    // One ratchet credits + rotates the active pointer.
    c.recordRatchet({ scoreDelta: 5, tokenCost: 100 });
    expect(c.active().id).toBe("s2");
    expect(c.activeHyperparams().population_size).toBe(16);
  });
});

describe("PbtController — fitness attribution", () => {
  test("recordRatchet credits the ACTIVE strategy (efficiency = scoreDelta/tokenCost)", () => {
    const seeds = fourSeeds();
    const c = new PbtController({ strategies: seeds, rng: seqRng([0.5]), exploitFraction: 0 });
    c.recordRatchet({ scoreDelta: 10, tokenCost: 100 }); // credits s1
    const s1 = c.strategies().find((s) => s.id === "s1")!;
    expect(s1.ratchetCount).toBe(1);
    expect(s1.fitness).toBeGreaterThan(0);
    // s2..s4 untouched.
    expect(c.strategies().find((s) => s.id === "s2")!.ratchetCount).toBe(0);
  });

  test("zero tokenCost does not divide-by-zero", () => {
    const c = new PbtController({ strategies: fourSeeds(), rng: seqRng([0.5]), exploitFraction: 0 });
    expect(() => c.recordRatchet({ scoreDelta: 3, tokenCost: 0 })).not.toThrow();
    expect(c.strategies().find((s) => s.id === "s1")!.fitness).toBeGreaterThan(0);
  });
});

describe("PbtController — exploit/explore (PBT sync)", () => {
  test("the worst strategy is replaced by a perturbed copy of a top performer", () => {
    const seeds = fourSeeds();
    // Pre-load fitness so ranking is deterministic: s1 best, s4 worst.
    seeds[0]!.fitness = 100;
    seeds[1]!.fitness = 50;
    seeds[2]!.fitness = 20;
    seeds[3]!.fitness = 1;
    // rng: first call picks the donor from the top pool (single donor → 0),
    // the rest drive the per-field perturbation.
    const c = new PbtController({
      strategies: seeds,
      rng: seqRng([0.0, 0.9, 0.1, 0.9, 0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      exploitFraction: 0.2,
      perturbation: 0.2,
    });
    const result = c.recordRatchet({ scoreDelta: 0, tokenCost: 1_000_000 }); // tiny credit to s1

    // Exactly one strategy replaced (floor(4*0.2)=0 → clamped to 1).
    expect(result.replaced.length).toBe(1);
    const replaced = result.replaced[0]!;
    expect(replaced.id).toBe("s4"); // worst
    // Donor is a top performer (s1), and the worst now resembles it
    // (mutation_rate moved away from 0.4 toward ~0.05, within ±20%).
    const s4 = c.strategies().find((s) => s.id === "s4")!;
    expect(s4.hyperparams.mutation_rate).toBeLessThan(0.4);
    // Its fitness is reset so the new config re-proves itself.
    expect(s4.fitness).toBe(0);
    // The donor keeps its identity + accumulated fitness.
    expect(c.strategies().find((s) => s.id === "s1")!.id).toBe("s1");
  });

  test("perturbed hyperparams stay within bounds", () => {
    const seeds = fourSeeds();
    seeds[0]!.fitness = 100;
    seeds[3]!.fitness = 1;
    const c = new PbtController({
      strategies: seeds,
      // all-high rng → maximal upward perturbation, must still clamp.
      rng: seqRng([0.0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
      exploitFraction: 0.2,
      perturbation: 0.5,
    });
    c.recordRatchet({ scoreDelta: 1, tokenCost: 100 });
    for (const s of c.strategies()) {
      expect(s.hyperparams.mutation_rate).toBeGreaterThanOrEqual(0.01);
      expect(s.hyperparams.mutation_rate).toBeLessThanOrEqual(0.8);
      expect(s.hyperparams.population_size).toBeGreaterThanOrEqual(4);
      expect(s.hyperparams.population_size).toBeLessThanOrEqual(64);
      expect(Number.isInteger(s.hyperparams.population_size)).toBe(true);
      expect(s.hyperparams.selection_pressure).toBeGreaterThanOrEqual(0.1);
      expect(s.hyperparams.zoom_policy.wild_explorer_pct).toBeGreaterThanOrEqual(0);
      expect(s.hyperparams.zoom_policy.wild_explorer_pct).toBeLessThanOrEqual(0.5);
    }
  });

  test("exploitFraction=0 disables replacement (pure rotation + crediting)", () => {
    const c = new PbtController({ strategies: fourSeeds(), rng: seqRng([0.5]), exploitFraction: 0 });
    const result = c.recordRatchet({ scoreDelta: 5, tokenCost: 100 });
    expect(result.replaced.length).toBe(0);
  });
});

describe("PbtController — rotation + degenerate sizes", () => {
  test("active pointer rotates round-robin and wraps", () => {
    const c = new PbtController({ strategies: fourSeeds(), rng: seqRng([0.5]), exploitFraction: 0 });
    const seen: string[] = [c.active().id];
    for (let i = 0; i < 4; i++) {
      c.recordRatchet({ scoreDelta: 1, tokenCost: 100 });
      seen.push(c.active().id);
    }
    expect(seen).toEqual(["s1", "s2", "s3", "s4", "s1"]);
  });

  test("a single strategy never tries to copy from itself", () => {
    const c = new PbtController({ strategies: [strat("only")], rng: seqRng([0.5]), exploitFraction: 0.2 });
    const result = c.recordRatchet({ scoreDelta: 5, tokenCost: 100 });
    expect(result.replaced.length).toBe(0);
    expect(c.active().id).toBe("only");
  });
});
