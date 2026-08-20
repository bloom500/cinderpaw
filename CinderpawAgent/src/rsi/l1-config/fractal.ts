/**
 * Faza 3 — Fractal Search: zoom primitives.
 *
 * Fractal search concentrates compute on promising regions of the genome
 * space by rescaling the mutation grammar (PLAN.md "Fractal Search"):
 *   - long escape-time regions are zoomed IN — `applyZoom(grammar, <1)`
 *     gives finer mutations, more samples near a promising point;
 *   - recalcitrant / stuck regions are zoomed OUT — `applyZoom(grammar,
 *     >1)` (or `coarseGrammar`) restores broad Level-0 exploration;
 *   - `WILD_EXPLORER_FRACTION` of births ignore the zoom policy entirely
 *     and mutate under the coarse grammar (`isWildExplorer`), keeping a
 *     constant trickle of global exploration so the search can't get
 *     permanently trapped in one basin.
 *
 * Zoom only rescales the CONTINUOUS step sizes (the two sigmas and the
 * simplex transfer epsilon). The categorical pool sizes and the
 * provider-aware temperature ceiling are copied verbatim, so no zoom
 * level can push a mutation past the grammar's hard bounds.
 */

import type { MutationGrammar } from "./mutation.ts";

/** Fraction of births that are fully-exploratory wild cards. */
export const WILD_EXPLORER_FRACTION = 0.05;

/** Zoom-out factor a wild explorer / recalcitrant region mutates under. */
export const COARSE_ZOOM_FACTOR = 3;

/** Clamp bounds on the zoom factor — never zero (would freeze the search)
 *  and never unbounded (would blow past any reasonable step). */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

const clampZoom = (f: number): number =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, f));

/**
 * Return a new grammar whose continuous step sizes are scaled by `factor`
 * (< 1 = zoom in / finer, > 1 = zoom out / coarser). The factor is
 * clamped to a sane positive range so a degenerate input can't freeze or
 * explode the search. The base grammar is not mutated.
 */
export function applyZoom(base: MutationGrammar, factor: number): MutationGrammar {
  const f = clampZoom(factor);
  return {
    ...base,
    temperatureSigma: base.temperatureSigma * f,
    contextWindowSigma: base.contextWindowSigma * f,
    transferEpsilon: base.transferEpsilon * f,
  };
}

/** The coarse, broadly-exploratory grammar (Level 0 / wild explorers). */
export function coarseGrammar(base: MutationGrammar): MutationGrammar {
  return applyZoom(base, COARSE_ZOOM_FACTOR);
}

/**
 * Decide whether this birth is a wild explorer (fully exploratory,
 * ignoring the zoom policy). Draws one uniform sample; true iff it falls
 * below `fraction` (default 5%).
 */
export function isWildExplorer(
  rng: () => number,
  fraction: number = WILD_EXPLORER_FRACTION,
): boolean {
  return rng() < fraction;
}
