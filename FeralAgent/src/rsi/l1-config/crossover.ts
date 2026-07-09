/**
 * Faza 2 — NEAT-Speciation Crossover: the config-blend operator.
 *
 * Produces a child `GenomeConfig` from two parents. The blend is
 * deterministic (no RNG) so a crossover birth is reproducible — a
 * requirement for Population-Based Training, which replays lineages.
 *
 * NEAT inherits disjoint/excess genes from the fitter parent and blends
 * the rest; here:
 *   - categorical genes (prompt/system template ids, retrieval strategy)
 *     come from the FITTER parent;
 *   - bounded reals (temperature, contextWindowUsage) are averaged;
 *   - toolPreferenceWeights are averaged element-wise then renormalised
 *     back onto the simplex;
 *   - decompositionDepth is the rounded mean.
 *
 * Averaging two in-bounds values stays in bounds and rounding a mean of
 * {0..3} stays in {0..3}, so no grammar clamp is needed. The caller is
 * the selection handler, which picks `fitter`/`other` from a
 * recent-common-ancestor + divergent-fingerprint pair (see the crossover
 * candidate selector).
 */

import type { GenomeConfig } from "./genome.ts";

const mean = (a: number, b: number) => (a + b) / 2;

/** Blend two parent configs into a child. `fitter` wins categorical ties. */
export function crossoverConfigs(
  fitter: GenomeConfig,
  other: GenomeConfig,
): GenomeConfig {
  return {
    // Categorical genes from the fitter parent.
    promptTemplateId: fitter.promptTemplateId,
    systemPromptId: fitter.systemPromptId,
    retrievalStrategy: fitter.retrievalStrategy,
    // Bounded reals: arithmetic mean.
    temperature: mean(fitter.temperature, other.temperature),
    contextWindowUsage: mean(fitter.contextWindowUsage, other.contextWindowUsage),
    // Simplex vector: element-wise mean, renormalised to sum 1.
    toolPreferenceWeights: blendSimplex(
      fitter.toolPreferenceWeights,
      other.toolPreferenceWeights,
    ),
    // Integer gene: rounded mean, stays in {0..3}.
    decompositionDepth: Math.round(
      mean(fitter.decompositionDepth, other.decompositionDepth),
    ),
  };
}

/**
 * Element-wise mean of two weight vectors, renormalised onto the simplex
 * (sum 1). Operates over the shorter length if they differ. Falls back
 * to a uniform vector if the blended weights sum to zero (degenerate),
 * so the result is always a valid point on the simplex.
 */
function blendSimplex(a: number[], b: number[]): number[] {
  const n = Math.min(a.length, b.length);
  const blended = Array.from({ length: n }, (_, i) => mean(a[i]!, b[i]!));
  const total = blended.reduce((s, w) => s + w, 0);
  if (total <= 0) return Array.from({ length: n }, () => 1 / n);
  return blended.map((w) => w / total);
}
