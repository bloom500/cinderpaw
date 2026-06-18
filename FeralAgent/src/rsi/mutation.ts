/**
 * Faza 1 — Async RSI Engine: grammar-constrained mutation operators.
 *
 * Each genome field mutates under its own operator with its own
 * invariant; Faza 1 stays parametric + grammar-constrained (no
 * LLM-driven mutations). RNG is injected (`() => number` in [0, 1)) so
 * every operator is deterministic and unit-testable.
 */

import { RETRIEVAL_STRATEGIES, type GenomeConfig } from "./genome.ts";

/** Uniform RNG over [0, 1). */
export type Rng = () => number;

export interface TransferOptions {
  /** Amount to move from donor to recipient (capped at the donor's balance). */
  epsilon: number;
  rng: Rng;
}

/**
 * Transfer mutation for a point on the simplex (weights summing to 1).
 *
 * A standard independent Gaussian perturbation would break the
 * sum-to-1 invariant, so instead we move `epsilon` of mass from a random
 * donor index to a random (distinct) recipient. The donor can give no
 * more than it holds, which also keeps every weight non-negative. The
 * sum is preserved exactly by construction. Returns a new array; the
 * input is not mutated.
 */
export function transferMutation(weights: number[], opts: TransferOptions): number[] {
  const n = weights.length;
  if (n < 2) return [...weights];

  const i = Math.min(n - 1, Math.floor(opts.rng() * n));
  let j = Math.min(n - 1, Math.floor(opts.rng() * n));
  if (j === i) j = (j + 1) % n;

  const delta = Math.min(weights[i]!, opts.epsilon);
  const out = [...weights];
  out[i] = weights[i]! - delta;
  out[j] = weights[j]! + delta;
  return out;
}

const clamp = (x: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, x));

export interface BoundedRealOptions {
  min: number;
  max: number;
  /** Step scale; the perturbation is `gaussian() * sigma`. */
  sigma: number;
  /** Standard-normal sample source (mean 0, std 1). Injected for tests. */
  gaussian: () => number;
}

/**
 * Gaussian perturbation of a real-valued field, clamped to [min, max].
 *
 * Used for `temperature` and `context_window_usage`. For temperature the
 * caller passes a provider-aware `max` (`min(2.0, providerMaxTemp)`, so
 * 1.0 on Anthropic) — this keeps the search space inside what the active
 * provider accepts and avoids two genomes that only differ above the
 * ceiling collapsing into one. For context_window the bounds are
 * [0.1, 0.95]: never zero context, and headroom for system-prompt overhead.
 */
export function mutateBoundedReal(current: number, opts: BoundedRealOptions): number {
  return clamp(current + opts.gaussian() * opts.sigma, opts.min, opts.max);
}

export interface RandomWalkOptions {
  min: number;
  max: number;
  rng: Rng;
}

/**
 * ±1 random walk on a small integer field, clamped to [min, max].
 * Used for `decomposition_depth` ({0,1,2,3}) — cleaner and faster than
 * Gaussian+round+clamp over only four discrete values.
 */
export function randomWalkInt(current: number, opts: RandomWalkOptions): number {
  const step = opts.rng() < 0.5 ? -1 : 1;
  return clamp(current + step, opts.min, opts.max);
}

/**
 * Uniform resample of an index into a pool of `poolSize` options. Used
 * for the categorical fields — `prompt_template_id`, `system_prompt_id`
 * (opaque indices into versioned pools) and `retrieval_strategy` (enum
 * index). Never returns an out-of-range index.
 */
export function resampleIndex(poolSize: number, rng: Rng): number {
  if (poolSize <= 1) return 0;
  return Math.min(poolSize - 1, Math.floor(rng() * poolSize));
}

/**
 * Standard-normal sample via Box–Muller, built from a uniform `rng`.
 * The production noise source for `mutateBoundedReal`; tests inject a
 * deterministic `gaussian` instead.
 */
export function standardGaussian(rng: Rng): number {
  let u1 = rng();
  if (u1 < Number.EPSILON) u1 = Number.EPSILON; // avoid log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Genome fields eligible for single-field mutation, in selection order. */
export const MUTABLE_FIELDS = [
  "promptTemplateId",
  "temperature",
  "systemPromptId",
  "retrievalStrategy",
  "contextWindowUsage",
  "toolPreferenceWeights",
  "decompositionDepth",
] as const;

export type MutableField = (typeof MUTABLE_FIELDS)[number];

/** Bounds + noise sources that constrain a parametric mutation. */
export interface MutationGrammar {
  templatePoolSize: number;
  systemPromptPoolSize: number;
  /** Provider-aware temperature ceiling: min(2.0, providerMaxTemp). */
  maxTemperature: number;
  temperatureSigma: number;
  contextWindowSigma: number;
  transferEpsilon: number;
  /** Uniform source (field choice, index resample, transfer indices, walk). */
  rng: Rng;
  /** Standard-normal source for the bounded-real fields. */
  gaussian: () => number;
}

export interface MutationResult {
  child: GenomeConfig;
  field: MutableField;
  /** Lineage crossover_type. Faza 1 mutations are all "parametric". */
  mutationType: "parametric";
}

/**
 * Produce a child genome from `parent` by mutating exactly one field
 * with its grammar-constrained operator. The field is chosen uniformly;
 * all other fields are copied verbatim. The parent is not mutated.
 */
export function mutateConfig(parent: GenomeConfig, g: MutationGrammar): MutationResult {
  const field = MUTABLE_FIELDS[resampleIndex(MUTABLE_FIELDS.length, g.rng)]!;
  const child: GenomeConfig = { ...parent, toolPreferenceWeights: [...parent.toolPreferenceWeights] };

  switch (field) {
    case "promptTemplateId":
      child.promptTemplateId = resampleIndex(g.templatePoolSize, g.rng);
      break;
    case "systemPromptId":
      child.systemPromptId = resampleIndex(g.systemPromptPoolSize, g.rng);
      break;
    case "retrievalStrategy":
      child.retrievalStrategy = RETRIEVAL_STRATEGIES[resampleIndex(RETRIEVAL_STRATEGIES.length, g.rng)]!;
      break;
    case "temperature":
      child.temperature = mutateBoundedReal(parent.temperature, {
        min: 0,
        max: g.maxTemperature,
        sigma: g.temperatureSigma,
        gaussian: g.gaussian,
      });
      break;
    case "contextWindowUsage":
      child.contextWindowUsage = mutateBoundedReal(parent.contextWindowUsage, {
        min: 0.1,
        max: 0.95,
        sigma: g.contextWindowSigma,
        gaussian: g.gaussian,
      });
      break;
    case "toolPreferenceWeights":
      child.toolPreferenceWeights = transferMutation(parent.toolPreferenceWeights, {
        epsilon: g.transferEpsilon,
        rng: g.rng,
      });
      break;
    case "decompositionDepth":
      child.decompositionDepth = randomWalkInt(parent.decompositionDepth, {
        min: 0,
        max: 3,
        rng: g.rng,
      });
      break;
  }

  return { child, field, mutationType: "parametric" };
}
