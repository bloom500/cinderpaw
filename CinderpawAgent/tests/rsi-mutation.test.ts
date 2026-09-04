/**
 * Faza 1 — Async RSI Engine: grammar-constrained mutation operators.
 *
 * Faza 1 mutations are parametric + grammar-constrained only (no
 * LLM-driven mutations yet). Each genome field has its own operator with
 * its own invariant, per the corrected grammar:
 *
 *   temperature            [0, maxTemperature] (provider-bounded) — Gaussian + clamp
 *   retrieval_strategy     enum — resample uniform
 *   decomposition_depth    {0,1,2,3} — random walk ±1 with clamp
 *   tool_preference_weights simplex — transfer mutation (ε from i to j)
 *   context_window_usage   [0.1, 0.95] — Gaussian + clamp
 *   prompt_template_id     index into pool — resample uniform
 *   system_prompt_id       index into pool — resample uniform
 *
 * RNG is injected so every operator is deterministic under test.
 */

import { describe, expect, test } from "bun:test";
import {
  mutateBoundedReal,
  randomWalkInt,
  resampleIndex,
  transferMutation,
} from "../src/rsi/l1-config/mutation.ts";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Deterministic RNG yielding the given values in sequence, then 0. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe("RSI mutation — tool_preference_weights (simplex)", () => {
  test("transfer mutation keeps weights on the simplex (sum=1, all >= 0)", () => {
    const weights = [0.25, 0.25, 0.25, 0.25];
    // rng picks donor i = floor(0.0*4)=0, recipient j = floor(0.3*4)=1.
    const out = transferMutation(weights, { epsilon: 0.1, rng: seqRng([0.0, 0.3]) });

    expect(sum(out)).toBeCloseTo(1);
    expect(out.every((w) => w >= 0)).toBe(true);
    expect(out).toEqual([0.15, 0.35, 0.25, 0.25]);
    // Input is not mutated in place.
    expect(weights).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  test("transfer never drives a weight negative (clamps to donor's balance)", () => {
    const weights = [0.05, 0.95];
    // donor i=0 (only has 0.05), recipient j=1, epsilon 0.1 > donor balance.
    const out = transferMutation(weights, { epsilon: 0.1, rng: seqRng([0.0, 0.6]) });

    expect(out.every((w) => w >= 0)).toBe(true);
    expect(sum(out)).toBeCloseTo(1);
    expect(out).toEqual([0, 1]); // took only the 0.05 available
  });
});

describe("RSI mutation — bounded real (temperature, context_window)", () => {
  test("a zero gaussian step leaves an in-bounds value unchanged", () => {
    const out = mutateBoundedReal(0.7, { min: 0, max: 2, sigma: 0.2, gaussian: () => 0 });
    expect(out).toBe(0.7);
  });

  test("clamps above the max (provider temperature ceiling)", () => {
    // current 0.9 + 100*0.2 step → way over; Anthropic ceiling 1.0.
    const out = mutateBoundedReal(0.9, { min: 0, max: 1.0, sigma: 0.2, gaussian: () => 100 });
    expect(out).toBe(1.0);
  });

  test("clamps below the min (context_window floor 0.1)", () => {
    const out = mutateBoundedReal(0.2, { min: 0.1, max: 0.95, sigma: 0.5, gaussian: () => -100 });
    expect(out).toBe(0.1);
  });
});

describe("RSI mutation — integer random walk (decomposition_depth)", () => {
  test("steps +1 or -1 and clamps at the boundaries {0..3}", () => {
    // rng < 0.5 → -1, rng >= 0.5 → +1.
    expect(randomWalkInt(2, { min: 0, max: 3, rng: () => 0.9 })).toBe(3); // +1
    expect(randomWalkInt(2, { min: 0, max: 3, rng: () => 0.1 })).toBe(1); // -1
    expect(randomWalkInt(3, { min: 0, max: 3, rng: () => 0.9 })).toBe(3); // +1 clamped
    expect(randomWalkInt(0, { min: 0, max: 3, rng: () => 0.1 })).toBe(0); // -1 clamped
  });
});

describe("RSI mutation — uniform index resample (pools, enum)", () => {
  test("resamples a uniform index within the pool", () => {
    expect(resampleIndex(4, () => 0.0)).toBe(0);
    expect(resampleIndex(4, () => 0.5)).toBe(2);
    expect(resampleIndex(4, () => 0.999)).toBe(3); // never out of range
  });
});
