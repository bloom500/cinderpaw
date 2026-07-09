/**
 * Faza 3 — Fractal Search: the zoom primitives.
 *
 * Fractal search concentrates compute on promising regions by scaling
 * the mutation grammar (PLAN.md "Fractal Search"):
 *   - a long escape-time region gets `applyZoom(grammar, <1)` — finer
 *     mutations, a zoom-in;
 *   - recalcitrance (a stuck region) gets `applyZoom(grammar, >1)` — a
 *     zoom-out to coarse, broad exploration;
 *   - 5% of births are wild explorers (`isWildExplorer`) that ignore the
 *     zoom policy and mutate under the coarse grammar.
 * Zoom only scales the continuous step sizes (sigmas + transfer epsilon);
 * categorical pools and the provider-aware temperature ceiling are
 * untouched, so a zoom can never push the search outside the grammar's
 * hard bounds.
 */

import { describe, expect, test } from "bun:test";
import {
  applyZoom,
  coarseGrammar,
  isWildExplorer,
  WILD_EXPLORER_FRACTION,
} from "../src/rsi/l1-config/fractal.ts";
import type { MutationGrammar } from "../src/rsi/l1-config/mutation.ts";

const base: MutationGrammar = {
  templatePoolSize: 8,
  systemPromptPoolSize: 4,
  maxTemperature: 1,
  temperatureSigma: 0.2,
  contextWindowSigma: 0.1,
  transferEpsilon: 0.05,
  rng: () => 0.5,
  gaussian: () => 0,
};

describe("applyZoom", () => {
  test("zoom-in (<1) shrinks the continuous step sizes", () => {
    const g = applyZoom(base, 0.5);
    expect(g.temperatureSigma).toBeCloseTo(0.1, 10);
    expect(g.contextWindowSigma).toBeCloseTo(0.05, 10);
    expect(g.transferEpsilon).toBeCloseTo(0.025, 10);
  });

  test("zoom-out (>1) grows the continuous step sizes", () => {
    const g = applyZoom(base, 2);
    expect(g.temperatureSigma).toBeCloseTo(0.4, 10);
    expect(g.contextWindowSigma).toBeCloseTo(0.2, 10);
  });

  test("leaves pools, temperature ceiling and noise sources untouched", () => {
    const g = applyZoom(base, 3);
    expect(g.templatePoolSize).toBe(8);
    expect(g.systemPromptPoolSize).toBe(4);
    expect(g.maxTemperature).toBe(1);
    expect(g.rng).toBe(base.rng);
    expect(g.gaussian).toBe(base.gaussian);
  });

  test("does not mutate the base grammar", () => {
    applyZoom(base, 0.25);
    expect(base.temperatureSigma).toBe(0.2);
  });

  test("clamps a non-positive or extreme factor to a sane range", () => {
    expect(applyZoom(base, 0).temperatureSigma).toBeGreaterThan(0);
    expect(applyZoom(base, -5).temperatureSigma).toBeGreaterThan(0);
    // huge factor is capped, not infinite
    expect(applyZoom(base, 1e6).temperatureSigma).toBeLessThan(Infinity);
  });
});

describe("coarseGrammar", () => {
  test("is a zoomed-out grammar (coarser than base)", () => {
    const g = coarseGrammar(base);
    expect(g.temperatureSigma).toBeGreaterThan(base.temperatureSigma);
  });
});

describe("isWildExplorer", () => {
  test("fires below the wild-explorer fraction, not above", () => {
    expect(isWildExplorer(() => WILD_EXPLORER_FRACTION - 0.001)).toBe(true);
    expect(isWildExplorer(() => WILD_EXPLORER_FRACTION + 0.001)).toBe(false);
  });

  test("default fraction is 5%", () => {
    expect(WILD_EXPLORER_FRACTION).toBeCloseTo(0.05, 10);
  });

  test("respects a custom fraction", () => {
    expect(isWildExplorer(() => 0.2, 0.5)).toBe(true);
    expect(isWildExplorer(() => 0.6, 0.5)).toBe(false);
  });
});
