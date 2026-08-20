/**
 * Faza 2 — NEAT-Speciation Crossover: the config-blend operator.
 *
 * `crossoverConfigs(fitter, other)` produces a child GenomeConfig from
 * two parents. The blend is deterministic (no RNG) so a crossover birth
 * is reproducible for PBT:
 *   - categorical genes (prompt/system template ids, retrieval strategy)
 *     are inherited from the FITTER parent — NEAT inherits disjoint genes
 *     from the more-fit parent;
 *   - bounded reals (temperature, contextWindowUsage) are averaged;
 *   - toolPreferenceWeights are averaged element-wise then renormalised
 *     back onto the simplex (sum 1);
 *   - decompositionDepth is the rounded mean (stays in {0..3}).
 * Averaging two in-bounds parents stays in bounds, so no grammar clamp
 * is needed here.
 */

import { describe, expect, test } from "bun:test";
import { crossoverConfigs } from "../src/rsi/l1-config/crossover.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

const fitter: GenomeConfig = {
  promptTemplateId: 3,
  temperature: 0.4,
  systemPromptId: 7,
  retrievalStrategy: "graph",
  contextWindowUsage: 0.2,
  toolPreferenceWeights: [0.7, 0.1, 0.1, 0.1],
  decompositionDepth: 1,
};

const other: GenomeConfig = {
  promptTemplateId: 9,
  temperature: 0.8,
  systemPromptId: 2,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.6,
  toolPreferenceWeights: [0.1, 0.3, 0.3, 0.3],
  decompositionDepth: 2,
};

describe("crossoverConfigs", () => {
  const child = crossoverConfigs(fitter, other);

  test("categorical genes come from the fitter parent", () => {
    expect(child.promptTemplateId).toBe(3);
    expect(child.systemPromptId).toBe(7);
    expect(child.retrievalStrategy).toBe("graph");
  });

  test("bounded reals are the arithmetic mean", () => {
    expect(child.temperature).toBeCloseTo(0.6, 10);
    expect(child.contextWindowUsage).toBeCloseTo(0.4, 10);
  });

  test("decompositionDepth is the rounded mean", () => {
    expect(child.decompositionDepth).toBe(2); // round((1+2)/2) = round(1.5) = 2
  });

  test("toolPreferenceWeights stay on the simplex (sum to 1)", () => {
    const sum = child.toolPreferenceWeights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(child.toolPreferenceWeights).toHaveLength(4);
  });

  test("toolPreferenceWeights are the renormalised element-wise mean", () => {
    // raw means: [0.4, 0.2, 0.2, 0.2] sum 1.0 → already normalised
    expect(child.toolPreferenceWeights[0]).toBeCloseTo(0.4, 10);
    expect(child.toolPreferenceWeights[1]).toBeCloseTo(0.2, 10);
  });

  test("is deterministic — same inputs give the same child", () => {
    expect(crossoverConfigs(fitter, other)).toEqual(child);
  });

  test("does not mutate either parent", () => {
    crossoverConfigs(fitter, other);
    expect(fitter.temperature).toBe(0.4);
    expect(other.toolPreferenceWeights).toEqual([0.1, 0.3, 0.3, 0.3]);
  });
});
