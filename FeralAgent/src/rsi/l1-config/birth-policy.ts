/**
 * Runtime wiring (Faza 2/3 into births) — the pure birth policy.
 *
 * `planBirth` composes the Faza 2/3 reproduction operators that were
 * built but not yet wired into the selection handler:
 *   - crossover (Faza 2) when a candidate pair is supplied;
 *   - otherwise a parametric mutation under a grammar zoomed by the
 *     region's escape-time (Faza 3 fractal search) — or the coarse
 *     grammar for a wild explorer;
 *   - then an optional taste-vector nudge (Faza 3 taste layer).
 *
 * It is pure and deterministic given the injected RNG, so reproduction
 * stays replayable for PBT. The handler owns parent/pair selection and
 * the stochastic wild/zoom decisions; it passes the resolved inputs in.
 */

import { crossoverConfigs } from "./crossover.ts";
import type { CrossoverPair } from "./crossover-selection.ts";
import { applyZoom, coarseGrammar } from "./fractal.ts";
import type { GenomeConfig } from "./genome.ts";
import { mutateConfig, type MutationGrammar } from "./mutation.ts";
import type { Genome } from "./population-manager.ts";
import { applyTasteToConfig } from "./taste.ts";

export interface BirthPlanDeps {
  /** Parent for the mutation path + lineage when there is no crossover. */
  parent: Genome;
  /** Base grammar (bounds + noise sources). */
  base: MutationGrammar;
  /** If supplied, the birth is a crossover of this fitter/other pair. */
  crossoverPair?: CrossoverPair | null;
  /** Wild explorer: mutate under the coarse grammar, ignoring zoom. */
  wild?: boolean;
  /** Zoom factor for the parent's region (Faza 3). Default 1 (no zoom). */
  zoomFactor?: number;
  /** Optional taste nudge applied to the produced child. */
  taste?: { vector: number[]; weight: number };
}

export interface BirthPlan {
  config: GenomeConfig;
  /** Audit label: "crossover" | "wild" | "parametric". */
  mutationType: string;
  lineage: string[];
  generation: number;
  wild: boolean;
}

export function planBirth(deps: BirthPlanDeps): BirthPlan {
  const wild = deps.wild ?? false;
  let config: GenomeConfig;
  let mutationType: string;
  let lineage: string[];
  let generation: number;

  if (deps.crossoverPair) {
    const { fitter, other } = deps.crossoverPair;
    config = crossoverConfigs(fitter.config!, other.config!);
    mutationType = "crossover";
    lineage = [fitter.id, other.id];
    generation = Math.max(fitter.generation, other.generation) + 1;
  } else {
    const grammar = wild
      ? coarseGrammar(deps.base)
      : applyZoom(deps.base, deps.zoomFactor ?? 1);
    config = mutateConfig(deps.parent.config!, grammar).child;
    mutationType = wild ? "wild" : "parametric";
    lineage = [deps.parent.id];
    generation = deps.parent.generation + 1;
  }

  if (deps.taste) {
    config = applyTasteToConfig(config, deps.taste.vector, deps.taste.weight, {
      maxTemperature: deps.base.maxTemperature,
    });
  }

  return { config, mutationType, lineage, generation, wild };
}
