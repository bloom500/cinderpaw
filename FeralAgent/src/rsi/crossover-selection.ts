/**
 * Faza 2 — NEAT-Speciation Crossover: candidate selection.
 *
 * Finds the genome pairs worth crossing (PLAN.md "NEAT-Speciation
 * Crossover"). A pair qualifies only when it BOTH:
 *   - shares a recent common ancestor (git LCA — injected; production
 *     wraps the bridge `rsi_lca` plus a recency check). This relatedness
 *     gate is what avoids destructive crossover between completely
 *     different regions of the search space; AND
 *   - has divergent behavioral fingerprints (cosine similarity below
 *     `divergenceThreshold`), so the cross actually mixes behaviours.
 *
 * Each pair is ordered fitter-first (the fitter parent's categorical
 * genes win in `crossoverConfigs`), and the pairs are ranked by combined
 * fitness so the caller can take the strongest.
 */

import {
  cosineSimilarity,
  type Genome,
  type PopulationManager,
} from "./population-manager.ts";

export interface CrossoverSelectionDeps {
  /** True iff the two genomes share a recent common ancestor (git LCA). */
  hasRecentCommonAncestor: (
    idA: string,
    idB: string,
  ) => Promise<boolean> | boolean;
  /** Cosine similarity strictly below this counts as "divergent". Default 0.85. */
  divergenceThreshold?: number;
}

export interface CrossoverPair {
  fitter: Genome;
  other: Genome;
}

/** Eligible = alive, evaluated, with a config and a fingerprint. */
function eligible(pop: PopulationManager): Genome[] {
  return pop
    .alive()
    .filter(
      (g) =>
        g.config != null &&
        g.fitnessScore !== null &&
        g.behavioralFingerprint !== null,
    );
}

export async function selectCrossoverPairs(
  pop: PopulationManager,
  deps: CrossoverSelectionDeps,
): Promise<CrossoverPair[]> {
  const threshold = deps.divergenceThreshold ?? 0.85;
  const genomes = eligible(pop);
  const pairs: Array<CrossoverPair & { combined: number }> = [];

  for (let i = 0; i < genomes.length; i++) {
    for (let j = i + 1; j < genomes.length; j++) {
      const a = genomes[i]!;
      const b = genomes[j]!;
      const similarity = cosineSimilarity(
        a.behavioralFingerprint!,
        b.behavioralFingerprint!,
      );
      if (similarity >= threshold) continue; // not divergent enough
      if (!(await deps.hasRecentCommonAncestor(a.id, b.id))) continue;

      const [fitter, other] =
        a.fitnessScore! >= b.fitnessScore! ? [a, b] : [b, a];
      pairs.push({
        fitter,
        other,
        combined: a.fitnessScore! + b.fitnessScore!,
      });
    }
  }

  pairs.sort((p, q) => q.combined - p.combined);
  return pairs.map(({ fitter, other }) => ({ fitter, other }));
}
