/**
 * Confidence gate — statistical significance for ratchet promotion.
 *
 * Why this exists (BRSI §2.7, refactor sequence step 3, audit landmine #4):
 *   Today the ratchet fires iff Rust says `candidate_score > prior_score_value`
 *   (`src-tauri/src/rsi/repo.rs:344`). That's the strict-greater invariant —
 *   the single source of truth for "main advances only on improvement". But
 *   "score went up by 0.001" is not the same as "the candidate is genuinely
 *   better". A single noisy eval can flip the gate by accident.
 *
 *   The BRSI confidence gate sits BEFORE the ratchet attempt in TS:
 *
 *     ratchet-handler.ts:77  ──►  evaluateGate(samples)  ──►  accept?
 *                                                       │
 *                                              reject  ─┴─►  skip the
 *                                                              ratchet attempt
 *
 *   Three tests must all pass for acceptance (BRSI §2.7):
 *     1. p-value (paired bootstrap) ≤ threshold
 *     2. Cohen's d (paired, on the diff distribution) ≥ threshold
 *     3. confidence (1 - p) ≥ threshold  (literal mirror of the spec,
 *        which lists both p and confidence for explicitness — they are
 *        mathematically redundant but a deliberate safety belt)
 *
 *   Plus an implicit fourth guard baked into the order of checks: the
 *   effect must be in the right direction. A negative d that passes
 *   the significance check still rejects — "candidate significantly
 *   worse" is a rejection, not a promotion.
 *
 * Discipline: pure functions, no IO, no globals. Deterministic given a
 * seed. Safe to call from `ratchet-handler.ts` before `rsi_ratchet_attempt`.
 *
 * Thresholds default to the strict gate (BRSI §9 #4, locked 2026-06-30):
 *   pValueMax = 0.05, effectSizeMin = 0.1, confidenceMin = 0.95.
 * SandboxBounds should own these in the live engine so the agent cannot
 * weaken them; this module takes them as a parameter to keep it pure.
 */

/** One task measured under both candidates. The Δ is `candidate - baseline`. */
export interface PairedSample {
  /** Score under the candidate (the genome / candidate we're testing). */
  candidate: number;
  /** Score under the baseline (the current champion / prior). */
  baseline: number;
}

/** Bootstrap distribution of the mean of paired differences. */
export interface BootstrapResult {
  /** Mean of the per-task differences. */
  mean: number;
  /** Lower bound of the (1-α) confidence interval. Default α = 0.05 → 2.5th pctile. */
  ciLower: number;
  /** Upper bound. Default α = 0.05 → 97.5th pctile. */
  ciUpper: number;
  /** One-sided p-value: P(bootstrap mean of Δ ≤ 0). */
  pValue: number;
  /** Cohen's d for paired samples: mean(Δ) / std(Δ). Sign carries direction. */
  effectSize: number;
}

/** Gate thresholds. All three must hold for acceptance. */
export interface GateThresholds {
  /** Maximum one-sided p-value. 0.05 by default. */
  pValueMax: number;
  /** Minimum |Cohen's d|. 0.1 by default. */
  effectSizeMin: number;
  /** Minimum confidence (1 - pValue). 0.95 by default. */
  confidenceMin: number;
}

/** Gate verdict: accept/reject plus the bootstrap details behind it. */
export interface GateDecision {
  accept: boolean;
  /** Human-readable reason; safe to surface in the Evolution Journal
   *  (`JournalEntry.decided.reason`) and the UI. */
  reason: string;
  /** Bootstrap details — useful for debugging rejected candidates. */
  bootstrap: BootstrapResult;
}

/** Minimum sample count. Below this the gate cannot meaningfully
 *  estimate variance; reject with "insufficient samples". 10 matches the
 *  paired-bootstrap rule of thumb (smallest sample where bootstrap
 *  variance stabilises). */
export const MIN_SAMPLES = 10;

/** Default gate thresholds — strict (BRSI §9 #4, locked 2026-06-30). */
export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  pValueMax: 0.05,
  effectSizeMin: 0.1,
  confidenceMin: 0.95,
};

/** Default bootstrap iterations. 10 000 is enough to estimate p < 0.05
 *  to ~2 decimal places without burning seconds per call. */
export const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;

/** Default RNG seed. Tests pass an explicit seed for determinism; the
 *  live engine can use any seed because the gate is called rarely and
 *  bootstrap variance is below the 0.05 p-threshold anyway. */
export const DEFAULT_SEED = 0xc0ffee;

/** Compute the bootstrap distribution of the mean of paired differences.
 *  Resamples Δ = (candidate - baseline) with replacement N times; the
 *  CI is the (α/2) and (1-α/2) percentiles of the bootstrap distribution;
 *  p-value is the proportion of bootstrap means ≤ 0.
 *
 *  Pure function. Deterministic given the same seed. */
export function bootstrapPaired(
  samples: readonly PairedSample[],
  iterations: number = DEFAULT_BOOTSTRAP_ITERATIONS,
  seed: number = DEFAULT_SEED,
): BootstrapResult {
  if (samples.length === 0 || iterations <= 0) {
    return { mean: 0, ciLower: 0, ciUpper: 0, pValue: 1, effectSize: 0 };
  }

  // Pre-compute the differences.
  const diffs: number[] = [];
  let sum = 0;
  for (const s of samples) {
    const d = s.candidate - s.baseline;
    diffs.push(d);
    sum += d;
  }
  const n = diffs.length;
  const mean = sum / n;

  // Sample variance of Δ (n - 1 denominator).
  let sqSum = 0;
  for (const d of diffs) {
    const dd = d - mean;
    sqSum += dd * dd;
  }
  const variance = n > 1 ? sqSum / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);

  // Cohen's d for paired samples. Returns 0 when stdDev is 0 (no signal
  // at all) rather than NaN/Infinity — a 0 effectSize correctly fails
  // every downstream gate.
  const effectSize = stdDev > 0 ? mean / stdDev : 0;

  // Bootstrap: resample Δ with replacement, compute mean of each resample.
  const rng = makeSeededRng(seed);
  const bootMeans = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) {
      // rng() ∈ [0, 1), so floor(rng() * n) ∈ [0, n-1] ⊂ [0, n).
      s += diffs[Math.floor(rng() * n)]!;
    }
    bootMeans[i] = s / n;
  }

  // CI: 2.5th and 97.5th percentiles (α = 0.05). Sort ascending.
  const sorted = [...bootMeans].sort((a, b) => a - b);
  const lowerIdx = Math.min(Math.floor(iterations * 0.025), sorted.length - 1);
  const upperIdx = Math.min(Math.floor(iterations * 0.975), sorted.length - 1);
  const ciLower = sorted[lowerIdx] ?? 0;
  const ciUpper = sorted[upperIdx] ?? 0;

  // One-sided p-value: P(bootstrap mean of Δ ≤ 0).
  let nonPositive = 0;
  for (const m of bootMeans) {
    if (m <= 0) nonPositive++;
  }
  const pValue = nonPositive / iterations;

  return { mean, ciLower, ciUpper, pValue, effectSize };
}

/** Evaluate the BRSI confidence gate. Returns accept/reject plus the
 *  reason + the bootstrap result behind it.
 *
 *  Precedence (each check runs only if all prior checks passed):
 *    1. Sample size ≥ MIN_SAMPLES (10). Otherwise reject.
 *    2. Effect direction (effectSize > 0). Otherwise reject — even a
 *       "significantly negative" effect is a rejection.
 *    3. Significance (pValue ≤ pValueMax).
 *    4. Effect magnitude (effectSize ≥ effectSizeMin).
 *    5. Confidence (1 - pValue ≥ confidenceMin).
 *
 *  Each rejection carries the most-specific reason first so the engine
 *  can surface it in the UI / journal. */
export function evaluateGate(
  samples: readonly PairedSample[],
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
  bootstrapIterations: number = DEFAULT_BOOTSTRAP_ITERATIONS,
): GateDecision {
  if (samples.length < MIN_SAMPLES) {
    return {
      accept: false,
      reason: `insufficient samples: need >= ${MIN_SAMPLES}, got ${samples.length}`,
      bootstrap: bootstrapPaired(samples, bootstrapIterations),
    };
  }

  const bootstrap = bootstrapPaired(samples, bootstrapIterations);
  const confidence = 1 - bootstrap.pValue;

  if (bootstrap.effectSize <= 0) {
    return {
      accept: false,
      reason: `candidate not better than baseline (d=${bootstrap.effectSize.toFixed(4)} <= 0)`,
      bootstrap,
    };
  }

  if (bootstrap.pValue > thresholds.pValueMax) {
    return {
      accept: false,
      reason: `not significant: p=${bootstrap.pValue.toFixed(4)} > ${thresholds.pValueMax}`,
      bootstrap,
    };
  }

  if (bootstrap.effectSize < thresholds.effectSizeMin) {
    return {
      accept: false,
      reason: `negligible effect: d=${bootstrap.effectSize.toFixed(4)} < ${thresholds.effectSizeMin}`,
      bootstrap,
    };
  }

  if (confidence < thresholds.confidenceMin) {
    return {
      accept: false,
      reason: `confidence ${confidence.toFixed(4)} < ${thresholds.confidenceMin}`,
      bootstrap,
    };
  }

  return {
    accept: true,
    reason:
      `accepted: Δ=${bootstrap.mean.toFixed(4)}, ` +
      `CI=[${bootstrap.ciLower.toFixed(4)}, ${bootstrap.ciUpper.toFixed(4)}], ` +
      `p=${bootstrap.pValue.toFixed(4)}, d=${bootstrap.effectSize.toFixed(4)}`,
    bootstrap,
  };
}

/** Mulberry32 — small, fast, deterministic 32-bit PRNG. The choice
 *  matters because the gate is called rarely but its determinism is
 *  tested heavily: tests pass a fixed seed and assert the same
 *  bootstrap distribution on every run.
 *
 *  Reference: https://gist.github.com/tommyettinger/46a3e9b1f6f6f7b1e6b6
 *  (Public domain.) */
function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}