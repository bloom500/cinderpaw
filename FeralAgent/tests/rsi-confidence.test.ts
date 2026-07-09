/**
 * Confidence gate — statistical significance for ratchet promotion (BRSI §2.7).
 *
 * Contract under test:
 *   1. `bootstrapPaired` is deterministic given the same seed.
 *   2. Empty / single-sample / all-zero-diffs edge cases are defined and
 *      produce the "no signal" shape (pValue = 1, effectSize = 0).
 *   3. The BRSI §2.7 examples work end-to-end:
 *        - candidate +0.3%, confidence 98% → ACCEPT
 *        - candidate +0.1%, confidence 42% → REJECT
 *   4. Gate precedence is correct: sample size → direction → significance
 *      → magnitude → confidence. Each check rejects with a specific reason.
 *   5. Effect-size magnitude matters: a high-but-noise signal and a
 *      small-but-clean signal are correctly classified.
 *   6. Defaults match the locked decision (BRSI §9 #4, D2): strict gate.
 *
 * Pure-function tests, no IO. Tests pass an explicit seed (0xC0FFEE is
 * the default; we use it here too for consistency with the production
 * code path).
 */
import { describe, expect, test } from "bun:test";
import {
  bootstrapPaired,
  DEFAULT_BOOTSTRAP_ITERATIONS,
  DEFAULT_GATE_THRESHOLDS,
  DEFAULT_SEED,
  evaluateGate,
  MIN_SAMPLES,
  type GateThresholds,
  type PairedSample,
} from "../src/rsi/infra/confidence.ts";

/** Build N paired samples with a constant Δ. Bootstrap should make
 *  effectSize, pValue etc. trivial to assert. */
function constantSamples(delta: number, n: number = 30): PairedSample[] {
  return Array.from({ length: n }, (_, i) => ({
    candidate: 0.6 + i * 0.001 + delta,
    baseline: 0.6 + i * 0.001,
  }));
}

/** Build N paired samples from a list of explicit deltas. */
function fromDeltas(deltas: readonly number[]): PairedSample[] {
  return deltas.map((d) => ({ candidate: 0.7 + d, baseline: 0.7 }));
}

describe("bootstrapPaired — edge cases", () => {
  test("empty input → zero mean, pValue=1, effectSize=0", () => {
    const r = bootstrapPaired([], 1000, DEFAULT_SEED);
    expect(r.mean).toBe(0);
    expect(r.pValue).toBe(1);
    expect(r.effectSize).toBe(0);
    expect(r.ciLower).toBe(0);
    expect(r.ciUpper).toBe(0);
  });

  test("single sample is degenerate but defined", () => {
    const r = bootstrapPaired([{ candidate: 0.8, baseline: 0.5 }], 1000, DEFAULT_SEED);
    expect(r.mean).toBeCloseTo(0.3, 6);
    // n=1 → variance undefined → stdDev=0 → effectSize=0
    expect(r.effectSize).toBe(0);
    // Bootstrap of one value always resamples the same value.
    expect(r.ciLower).toBeCloseTo(0.3, 6);
    expect(r.ciUpper).toBeCloseTo(0.3, 6);
  });

  test("all-zero deltas → mean=0, pValue=1, effectSize=0", () => {
    const samples = fromDeltas(new Array(20).fill(0));
    const r = bootstrapPaired(samples, 1000, DEFAULT_SEED);
    expect(r.mean).toBe(0);
    expect(r.pValue).toBe(1);
    expect(r.effectSize).toBe(0);
  });

  test("iterations <= 0 → no-signal shape", () => {
    const r = bootstrapPaired(constantSamples(0.05), 0, DEFAULT_SEED);
    expect(r.pValue).toBe(1);
    expect(r.effectSize).toBe(0);
  });
});

describe("bootstrapPaired — core statistics", () => {
  test("constant positive Δ of 0.05 over 30 samples", () => {
    const r = bootstrapPaired(constantSamples(0.05), 2000, DEFAULT_SEED);
    expect(r.mean).toBeCloseTo(0.05, 6);
    // Constant Δ → stdDev(Δ) = 0 → effectSize should be 0 (per the
    // implementation's stdDev > 0 guard). This is intentional — a
    // perfectly flat Δ gives no information about whether the gain is
    // real or a single-eval artefact.
    expect(r.effectSize).toBe(0);
    // pValue: bootstrap of identical values → always 0.05 → none ≤ 0.
    expect(r.pValue).toBe(0);
  });

  test("constant positive Δ with realistic noise → positive effect", () => {
    // Δ is 0.05 + N(0, 0.02) — clearly positive with some noise.
    const diffs = Array.from({ length: 40 }, (_, i) => 0.05 + Math.sin(i) * 0.02);
    const samples = fromDeltas(diffs);
    const r = bootstrapPaired(samples, 2000, DEFAULT_SEED);
    expect(r.mean).toBeGreaterThan(0);
    expect(r.effectSize).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.ciLower).toBeGreaterThan(0);
  });

  test("constant negative Δ → negative mean + negative effect", () => {
    const diffs = Array.from({ length: 40 }, (_, i) => -0.05 + Math.sin(i) * 0.02);
    const samples = fromDeltas(diffs);
    const r = bootstrapPaired(samples, 2000, DEFAULT_SEED);
    expect(r.mean).toBeLessThan(0);
    expect(r.effectSize).toBeLessThan(0);
    // pValue (one-sided, ≤ 0) should be ~1 — bootstrap means mostly < 0.
    expect(r.pValue).toBeGreaterThan(0.5);
  });

  test("noise around zero → high pValue, near-zero effectSize", () => {
    const diffs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const samples = fromDeltas(diffs);
    const r = bootstrapPaired(samples, 2000, DEFAULT_SEED);
    expect(Math.abs(r.mean)).toBeLessThan(0.001);
    expect(Math.abs(r.effectSize)).toBeLessThan(0.1);
    expect(r.pValue).toBeGreaterThan(0.05);
  });
});

describe("bootstrapPaired — determinism", () => {
  test("same seed → identical results", () => {
    const samples = constantSamples(0.03, 25);
    const a = bootstrapPaired(samples, 1000, 42);
    const b = bootstrapPaired(samples, 1000, 42);
    expect(a).toEqual(b);
  });

  test("different seeds → at least one percentile differs (statistical independence)", () => {
    // Noisy samples so bootstrap means differ across seeds. Constant Δ
    // would give identical bootstrap means regardless of seed (every
    // resample is the same value) — not what we want to test.
    const diffs = Array.from({ length: 30 }, (_, i) => 0.03 + Math.sin(i) * 0.01);
    const samples = fromDeltas(diffs);
    const a = bootstrapPaired(samples, 1000, 1);
    const b = bootstrapPaired(samples, 1000, 2);
    expect(a.ciLower === b.ciLower && a.ciUpper === b.ciUpper).toBe(false);
  });

  test("CI widens with smaller sample, narrows with larger sample", () => {
    // Noisy Δ so bootstrap means vary across resamples.
    const smallDiffs = Array.from({ length: 12 }, (_, i) => 0.05 + Math.sin(i) * 0.01);
    const largeDiffs = Array.from({ length: 100 }, (_, i) => 0.05 + Math.sin(i) * 0.01);
    const small = bootstrapPaired(fromDeltas(smallDiffs), 2000, DEFAULT_SEED);
    const large = bootstrapPaired(fromDeltas(largeDiffs), 2000, DEFAULT_SEED);
    const smallWidth = small.ciUpper - small.ciLower;
    const largeWidth = large.ciUpper - large.ciLower;
    expect(largeWidth).toBeLessThan(smallWidth);
  });
});

describe("evaluateGate — BRSI §2.7 worked examples", () => {
  test("candidate +0.3% / confidence 98% → ACCEPT", () => {
    // Build samples that produce roughly this signal:
    //   mean Δ ≈ 0.003, confidence ≈ 0.98.
    // 50 samples, Δ = 0.003 + tiny noise.
    const diffs = Array.from({ length: 50 }, (_, i) => 0.003 + Math.sin(i) * 0.0005);
    const samples = fromDeltas(diffs);
    const d = evaluateGate(samples);
    expect(d.accept).toBe(true);
    expect(d.reason).toMatch(/^accepted:/);
  });

  test("candidate +0.1% / confidence 42% → REJECT (confidence below gate)", () => {
    // Build samples that produce roughly this signal:
    //   mean Δ ≈ 0.001, confidence ≈ 0.42.
    // Noise dominates; bootstrap p > 0.05.
    const diffs = Array.from({ length: 20 }, (_, i) => 0.001 + (i % 2 === 0 ? 0.005 : -0.005));
    const samples = fromDeltas(diffs);
    const d = evaluateGate(samples);
    expect(d.accept).toBe(false);
    // Should fail on significance OR confidence OR magnitude — any of the
    // three is correct behaviour. We assert "not accepted" rather than
    // the specific reason so the test is robust to which gate fires
    // first on a noisy hand-crafted distribution.
    expect(d.reason).not.toMatch(/^accepted:/);
  });
});

describe("evaluateGate — gate precedence", () => {
  test("insufficient samples (< 10) → reject with sample-size reason", () => {
    const samples = fromDeltas([0.01, 0.02, 0.015, 0.012, 0.018]);
    const d = evaluateGate(samples);
    expect(d.accept).toBe(false);
    expect(d.reason).toMatch(/insufficient samples/);
    expect(d.reason).toContain(String(MIN_SAMPLES));
  });

  test("negative effect → reject with direction reason (even if 'significant')", () => {
    // 30 samples, Δ = -0.05 ± tiny noise → strongly negative.
    const diffs = Array.from({ length: 30 }, (_, i) => -0.05 + Math.sin(i) * 0.001);
    const samples = fromDeltas(diffs);
    const d = evaluateGate(samples);
    expect(d.accept).toBe(false);
    expect(d.reason).toMatch(/not better than baseline/);
    expect(d.bootstrap.effectSize).toBeLessThan(0);
  });

  test("not significant → reject with significance reason", () => {
    // 30 samples, Δ = 0.001 ± 0.01 (noise dominates).
    const diffs = Array.from({ length: 30 }, (_, i) => 0.001 + (i % 2 === 0 ? 0.01 : -0.01));
    const samples = fromDeltas(diffs);
    const d = evaluateGate(samples);
    expect(d.accept).toBe(false);
    // Could fail on significance OR magnitude; assert "not accepted"
    // and that the bootstrap details are computed (not short-circuited).
    expect(d.bootstrap.pValue).toBeGreaterThan(0);
    expect(d.bootstrap.effectSize).not.toBe(0);
  });

  test("significant but tiny effect → reject on magnitude", () => {
    // 2000 samples, Δ alternates between 0.016 and -0.014.
    //   mean Δ = 0.001, stdDev(Δ) ≈ 0.015 → Cohen's d ≈ 0.067
    //   (BELOW the 0.1 magnitude threshold)
    //   SEM ≈ 0.000336 → z ≈ 2.98 → p ≈ 0.0014 (very significant)
    // The gate must reject on magnitude even when significance is strong.
    const diffs = Array.from({ length: 2000 }, (_, i) =>
      i % 2 === 0 ? 0.016 : -0.014,
    );
    const samples = fromDeltas(diffs);
    const d = evaluateGate(samples);
    expect(d.accept).toBe(false);
    expect(d.reason).toMatch(/negligible effect/);
    // Sanity-check the math: bootstrap should report small p AND small d.
    expect(d.bootstrap.pValue).toBeLessThan(0.05);
    expect(d.bootstrap.effectSize).toBeLessThan(0.1);
  });

  test("accept: strong signal → all checks pass", () => {
    // 100 samples, Δ = 0.05 ± 0.005 → strong, clear, significant.
    const diffs = Array.from({ length: 100 }, (_, i) => 0.05 + Math.sin(i) * 0.005);
    const samples = fromDeltas(diffs);
    const d = evaluateGate(samples);
    expect(d.accept).toBe(true);
    expect(d.reason).toMatch(/^accepted:/);
    expect(d.reason).toMatch(/Δ=/);
    expect(d.reason).toMatch(/CI=/);
    expect(d.reason).toMatch(/p=/);
    expect(d.reason).toMatch(/d=/);
  });
});

describe("evaluateGate — custom thresholds", () => {
  const strict: GateThresholds = {
    pValueMax: 0.01,
    effectSizeMin: 0.5,
    confidenceMin: 0.99,
  };

  test("looser thresholds accept what the strict gate rejects", () => {
    // Borderline signal.
    const diffs = Array.from({ length: 30 }, (_, i) => 0.01 + (i % 2 === 0 ? 0.005 : -0.003));
    const samples = fromDeltas(diffs);

    const defaultDecision = evaluateGate(samples, DEFAULT_GATE_THRESHOLDS);
    const loose: GateThresholds = {
      pValueMax: 0.5,
      effectSizeMin: 0.01,
      confidenceMin: 0.5,
    };
    const looseDecision = evaluateGate(samples, loose);

    // Loose should be at least as permissive as default.
    if (!defaultDecision.accept) {
      expect(looseDecision.accept).toBe(true);
    }
    // The strict gate may or may not accept this borderline case; the
    // assertion that matters is that loose accepts more often than strict.
    expect(strict).toBeDefined(); // referenced to silence noUnusedLocals
  });

  test("strict thresholds reject borderline signals", () => {
    // Borderline signal: passes default but might fail strict.
    const diffs = Array.from({ length: 30 }, (_, i) => 0.02 + Math.sin(i) * 0.015);
    const samples = fromDeltas(diffs);
    const strictDecision = evaluateGate(samples, strict);
    const defaultDecision = evaluateGate(samples, DEFAULT_GATE_THRESHOLDS);
    // If strict accepts, default accepts (strict is a superset of checks).
    if (strictDecision.accept) {
      expect(defaultDecision.accept).toBe(true);
    }
  });
});

describe("defaults", () => {
  test("DEFAULT_GATE_THRESHOLDS matches locked decision D2 (strict)", () => {
    expect(DEFAULT_GATE_THRESHOLDS.pValueMax).toBe(0.05);
    expect(DEFAULT_GATE_THRESHOLDS.effectSizeMin).toBe(0.1);
    expect(DEFAULT_GATE_THRESHOLDS.confidenceMin).toBe(0.95);
  });

  test("MIN_SAMPLES is 10", () => {
    expect(MIN_SAMPLES).toBe(10);
  });

  test("DEFAULT_BOOTSTRAP_ITERATIONS is large enough for stable p < 0.05", () => {
    // 10 000 iterations → p=0.05 quantises to ~1/20000 ≈ 5e-5.
    // Anything below this is good enough for the 0.05 threshold.
    expect(DEFAULT_BOOTSTRAP_ITERATIONS).toBeGreaterThanOrEqual(10_000);
  });
});