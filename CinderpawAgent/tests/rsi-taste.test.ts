/**
 * Faza 3 — Taste Layer: the taste-vector miner.
 *
 * At each RatchetAdvanced the engine mines a taste vector from the last
 * ~20 ratchet commits: the mean direction (winner − loser) over the
 * numeric genome dimensions (PLAN.md "Fractal Search + Taste Layer").
 * The result biases GenomeBorn sampling toward what has been winning.
 * The miner is pure over injected winner/loser pairs — the
 * commit-history extraction is production wiring; the maths is here and
 * deterministic so PBT can replay it.
 */

import { describe, expect, test } from "bun:test";
import {
  configToVector,
  mineTasteVector,
  TASTE_DIMS,
} from "../src/rsi/l1-config/taste.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

const cfg = (over: Partial<GenomeConfig> = {}): GenomeConfig => ({
  promptTemplateId: 0,
  temperature: 0.5,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
  ...over,
});

describe("configToVector", () => {
  test("flattens the numeric dimensions in a stable order/length", () => {
    expect(configToVector(cfg())).toEqual([0.5, 0.5, 1, 0.25, 0.25, 0.25, 0.25]);
    expect(TASTE_DIMS).toBe(7);
  });
});

describe("mineTasteVector", () => {
  test("a single pair is the winner − loser direction", () => {
    const taste = mineTasteVector([
      { winner: cfg({ temperature: 0.8 }), loser: cfg({ temperature: 0.4 }) },
    ]);
    expect(taste[0]).toBeCloseTo(0.4, 10); // temperature dim
    expect(taste[1]).toBeCloseTo(0, 10); // contextWindowUsage unchanged
  });

  test("averages the direction over multiple pairs", () => {
    const taste = mineTasteVector([
      { winner: cfg({ contextWindowUsage: 0.9 }), loser: cfg({ contextWindowUsage: 0.5 }) }, // +0.4
      { winner: cfg({ contextWindowUsage: 0.5 }), loser: cfg({ contextWindowUsage: 0.7 }) }, // -0.2
    ]);
    expect(taste[1]).toBeCloseTo(0.1, 10); // mean(0.4, -0.2)
  });

  test("an empty history is the zero vector", () => {
    expect(mineTasteVector([])).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("does not mutate the input configs", () => {
    const w = cfg({ temperature: 0.8 });
    const l = cfg({ temperature: 0.4 });
    mineTasteVector([{ winner: w, loser: l }]);
    expect(w.temperature).toBe(0.8);
    expect(l.toolPreferenceWeights).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});
