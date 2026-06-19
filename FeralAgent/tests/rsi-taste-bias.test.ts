/**
 * Faza 3 — Taste Layer: weight + biased sampling.
 *
 * The taste weight grows with population size and history depth (PLAN.md:
 * "at small populations the weight is small (no history yet), at large
 * populations the weight is large"). `applyTasteToConfig` nudges a
 * child's numeric genes toward the taste direction by that weight while
 * respecting every grammar bound — temperature/context clamped,
 * decompositionDepth kept an integer in {0..3}, toolPreferenceWeights
 * kept on the simplex — so a biased birth is still a legal genome.
 */

import { describe, expect, test } from "bun:test";
import { applyTasteToConfig, tasteWeight } from "../src/rsi/taste.ts";
import type { GenomeConfig } from "../src/rsi/genome.ts";

const cfg = (over: Partial<GenomeConfig> = {}): GenomeConfig => ({
  promptTemplateId: 2,
  temperature: 0.5,
  systemPromptId: 3,
  retrievalStrategy: "graph",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
  ...over,
});

describe("tasteWeight", () => {
  test("is zero with no history", () => {
    expect(tasteWeight(50, 0)).toBeCloseTo(0, 10);
  });

  test("grows monotonically with population size", () => {
    expect(tasteWeight(50, 20)).toBeGreaterThan(tasteWeight(5, 20));
  });

  test("grows monotonically with history depth", () => {
    expect(tasteWeight(20, 20)).toBeGreaterThan(tasteWeight(20, 2));
  });

  test("is bounded below the configured max weight", () => {
    expect(tasteWeight(1e6, 1e6, { maxWeight: 0.5 })).toBeLessThanOrEqual(0.5);
    expect(tasteWeight(1e6, 1e6, { maxWeight: 0.5 })).toBeGreaterThan(0.4);
  });
});

describe("applyTasteToConfig", () => {
  const taste = [0.2, 0.2, 1, 0.4, 0, 0, 0]; // push temp/ctx/depth/tool0 up

  test("weight 0 leaves the numeric genes unchanged", () => {
    const out = applyTasteToConfig(cfg(), taste, 0);
    expect(out.temperature).toBeCloseTo(0.5, 10);
    expect(out.contextWindowUsage).toBeCloseTo(0.5, 10);
    expect(out.decompositionDepth).toBe(1);
  });

  test("nudges numeric genes toward the taste direction", () => {
    const out = applyTasteToConfig(cfg(), taste, 0.5);
    expect(out.temperature).toBeGreaterThan(0.5);
    expect(out.contextWindowUsage).toBeGreaterThan(0.5);
  });

  test("respects bounds (temperature ≤ ceiling, context in [0.1,0.95])", () => {
    const out = applyTasteToConfig(
      cfg({ temperature: 0.95, contextWindowUsage: 0.94 }),
      taste,
      5, // large push
      { maxTemperature: 1 },
    );
    expect(out.temperature).toBeLessThanOrEqual(1);
    expect(out.contextWindowUsage).toBeLessThanOrEqual(0.95);
  });

  test("keeps decompositionDepth an integer in {0..3}", () => {
    const out = applyTasteToConfig(cfg({ decompositionDepth: 3 }), taste, 5);
    expect(Number.isInteger(out.decompositionDepth)).toBe(true);
    expect(out.decompositionDepth).toBeLessThanOrEqual(3);
    expect(out.decompositionDepth).toBeGreaterThanOrEqual(0);
  });

  test("keeps toolPreferenceWeights on the simplex", () => {
    const out = applyTasteToConfig(cfg(), taste, 2);
    const sum = out.toolPreferenceWeights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(out.toolPreferenceWeights.every((w) => w >= 0)).toBe(true);
  });

  test("preserves categorical genes and does not mutate the input", () => {
    const c = cfg();
    const out = applyTasteToConfig(c, taste, 0.5);
    expect(out.retrievalStrategy).toBe("graph");
    expect(out.promptTemplateId).toBe(2);
    expect(c.temperature).toBe(0.5); // input untouched
  });
});
