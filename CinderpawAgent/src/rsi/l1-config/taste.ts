/**
 * Faza 3 — Taste Layer: the taste-vector miner.
 *
 * A taste vector is the mean direction (winner − loser) over the numeric
 * genome dimensions, mined from the last ~20 ratchet commits' winning vs
 * losing genomes (PLAN.md "Fractal Search + Taste Layer"). It biases
 * GenomeBorn sampling toward the region the search has been winning in.
 *
 * The miner is pure over injected winner/loser pairs; the commit-history
 * extraction (git log of the last 20 ratchet commits + their losing
 * siblings, via the bridge) is production wiring. The maths is
 * deterministic so PBT can replay a lineage exactly.
 *
 * Only numeric dimensions carry a direction; the opaque categorical
 * indices (prompt/system ids, retrieval strategy) are excluded — "move
 * toward template 7" is not a meaningful direction.
 */

import type { GenomeConfig } from "./genome.ts";

/** Length of the taste vector: temperature, contextWindowUsage,
 *  decompositionDepth, + 4 toolPreferenceWeights. */
export const TASTE_DIMS = 7;

/** One mined comparison: a winning genome and the losing one it beat. */
export interface RatchetPair {
  winner: GenomeConfig;
  loser: GenomeConfig;
}

/** Flatten a config's numeric dimensions in a stable order. */
export function configToVector(c: GenomeConfig): number[] {
  return [
    c.temperature,
    c.contextWindowUsage,
    c.decompositionDepth,
    ...c.toolPreferenceWeights,
  ];
}

/**
 * Mean (winner − loser) direction over the numeric dimensions. An empty
 * history yields the zero vector (no taste yet). Vectors are compared
 * over the shorter length if a config carries fewer tool weights than
 * expected, so a malformed historical genome can't crash the mine.
 */
export function mineTasteVector(pairs: RatchetPair[]): number[] {
  const taste = new Array<number>(TASTE_DIMS).fill(0);
  if (pairs.length === 0) return taste;

  for (const { winner, loser } of pairs) {
    const w = configToVector(winner);
    const l = configToVector(loser);
    const n = Math.min(taste.length, w.length, l.length);
    for (let i = 0; i < n; i++) taste[i]! += w[i]! - l[i]!;
  }
  return taste.map((sum) => sum / pairs.length);
}

export interface TasteWeightOptions {
  /** Upper bound on the weight (asymptote). Default 0.5. */
  maxWeight?: number;
  /** Population size at which the population factor reaches 1/2. Default 20. */
  popHalf?: number;
  /** History depth at which the history factor reaches 1/2. Default 20. */
  historyHalf?: number;
}

/**
 * How strongly to trust the taste vector, in [0, maxWeight). It is the
 * product of two saturating curves — one in population size, one in
 * history depth — so the weight is near zero when either is small (a
 * fresh, tiny run has no reliable taste) and approaches `maxWeight` as
 * both grow. With `historyDepth = 0` the weight is exactly 0.
 */
export function tasteWeight(
  populationSize: number,
  historyDepth: number,
  opts: TasteWeightOptions = {},
): number {
  const maxWeight = opts.maxWeight ?? 0.5;
  const popHalf = opts.popHalf ?? 20;
  const historyHalf = opts.historyHalf ?? 20;
  const saturate = (x: number, half: number) =>
    x <= 0 ? 0 : x / (x + half);
  return maxWeight * saturate(populationSize, popHalf) * saturate(historyDepth, historyHalf);
}

const clamp = (x: number, min: number, max: number) =>
  Math.min(max, Math.max(min, x));

export interface TasteBiasOptions {
  /** Provider-aware temperature ceiling: min(2.0, providerMaxTemp). Default 1. */
  maxTemperature?: number;
}

/**
 * Nudge a child config's numeric genes toward `taste` by `weight`,
 * keeping every grammar bound: temperature clamped to [0, maxTemperature],
 * contextWindowUsage to [0.1, 0.95], decompositionDepth rounded into
 * {0..3}, and toolPreferenceWeights projected back onto the simplex
 * (negatives clamped to 0, then renormalised). Categorical genes are
 * copied verbatim — taste has no direction for opaque indices. The input
 * config is not mutated.
 */
export function applyTasteToConfig(
  config: GenomeConfig,
  taste: number[],
  weight: number,
  opts: TasteBiasOptions = {},
): GenomeConfig {
  const maxTemperature = opts.maxTemperature ?? 1;
  const t = taste;
  const weights = config.toolPreferenceWeights.map(
    (w, i) => w + weight * (t[3 + i] ?? 0),
  );
  return {
    ...config,
    temperature: clamp(config.temperature + weight * (t[0] ?? 0), 0, maxTemperature),
    contextWindowUsage: clamp(
      config.contextWindowUsage + weight * (t[1] ?? 0),
      0.1,
      0.95,
    ),
    decompositionDepth: clamp(
      Math.round(config.decompositionDepth + weight * (t[2] ?? 0)),
      0,
      3,
    ),
    toolPreferenceWeights: projectSimplex(weights),
  };
}

/** Clamp negatives to 0 and renormalise to sum 1; uniform if degenerate. */
function projectSimplex(weights: number[]): number[] {
  const nonNeg = weights.map((w) => Math.max(0, w));
  const total = nonNeg.reduce((s, w) => s + w, 0);
  if (total <= 0) return nonNeg.map(() => 1 / nonNeg.length);
  return nonNeg.map((w) => w / total);
}
