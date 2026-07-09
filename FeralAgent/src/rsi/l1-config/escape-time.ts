/**
 * Faza 3 — Fractal Search: escape-time tracking.
 *
 * Escape-time = how many iterations a lineage survives before it
 * plateaus (PLAN.md "Fractal Search"). The genome space is quantised
 * into regions; the tracker accumulates escape-times per region and maps
 * them to:
 *   - a zoom factor (long escape-time → factor < 1, a zoom-in to finer
 *     mutations; short → near 1, stay coarse), fed to `applyZoom`; and
 *   - a prune decision (a region with a low mean escape-time and enough
 *     evidence is a dead end and should stop being sampled).
 */

import type { GenomeConfig } from "./genome.ts";

/**
 * Escape-time of a lineage given its scores in birth order: the number
 * of strictly-improving steps before the first plateau (a step that does
 * not improve on the previous score). A single score or an immediate
 * stall is escape-time 0.
 */
export function escapeTimeOf(scores: number[]): number {
  let t = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i]! > scores[i - 1]!) t += 1;
    else break;
  }
  return t;
}

/** Number of buckets each continuous field is quantised into. */
const BINS = 4;
const TEMP_MAX = 1; // provider-aware ceiling (Anthropic = 1.0)
const CTX_MIN = 0.1;
const CTX_MAX = 0.95;

const bin = (x: number, min: number, max: number, bins: number): number => {
  const clamped = Math.min(max, Math.max(min, x));
  const idx = Math.floor(((clamped - min) / (max - min)) * bins);
  return Math.min(bins - 1, idx); // top edge falls in the last bucket
};

/**
 * Quantise a genome config into a region key. Continuous fields
 * (temperature, contextWindowUsage) are binned; the behaviourally-coarse
 * categoricals (retrievalStrategy, decompositionDepth) are kept exact.
 * High-cardinality opaque indices (prompt/system template ids) are
 * deliberately excluded so regions stay coarse enough to accumulate
 * escape-time evidence.
 */
export function regionKey(config: GenomeConfig): string {
  const t = bin(config.temperature, 0, TEMP_MAX, BINS);
  const c = bin(config.contextWindowUsage, CTX_MIN, CTX_MAX, BINS);
  return `t${t}:c${c}:r${config.retrievalStrategy}:d${config.decompositionDepth}`;
}

export interface EscapeTimeOptions {
  /** Mean escape-time at/below which a region is a prune candidate. Default 1. */
  pruneThreshold?: number;
  /** Minimum samples before pruning is allowed (avoid early false prune). Default 5. */
  minSamples?: number;
  /** Sensitivity of the zoom-in response to escape-time. Default 0.5. */
  zoomSensitivity?: number;
}

export class EscapeTimeTracker {
  private readonly samples = new Map<string, number[]>();
  private readonly pruneThreshold: number;
  private readonly minSamples: number;
  private readonly zoomSensitivity: number;

  constructor(opts: EscapeTimeOptions = {}) {
    this.pruneThreshold = opts.pruneThreshold ?? 1;
    this.minSamples = opts.minSamples ?? 5;
    this.zoomSensitivity = opts.zoomSensitivity ?? 0.5;
  }

  /** Record an observed escape-time for a region. */
  record(region: string, escapeTime: number): void {
    const list = this.samples.get(region);
    if (list) list.push(escapeTime);
    else this.samples.set(region, [escapeTime]);
  }

  /** Mean escape-time for a region, or 0 if unseen. */
  meanEscapeTime(region: string): number {
    const list = this.samples.get(region);
    if (!list || list.length === 0) return 0;
    return list.reduce((a, b) => a + b, 0) / list.length;
  }

  /**
   * Zoom factor for a region. An unseen region is neutral (1, stay
   * coarse). The longer the mean escape-time, the smaller the factor
   * (zoom in for finer mutations): `1 / (1 + mean * sensitivity)`, which
   * is 1 at escape-time 0 and decreases monotonically.
   */
  zoomFactorFor(region: string): number {
    const mean = this.meanEscapeTime(region);
    if (mean <= 0) return 1;
    return 1 / (1 + mean * this.zoomSensitivity);
  }

  /** True iff the region is an evidenced dead end (low mean escape-time). */
  shouldPrune(region: string): boolean {
    const list = this.samples.get(region);
    if (!list || list.length < this.minSamples) return false;
    return this.meanEscapeTime(region) <= this.pruneThreshold;
  }
}
