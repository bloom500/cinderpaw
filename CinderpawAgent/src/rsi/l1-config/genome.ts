/**
 * Faza 1 — Async RSI Engine: the genome config (the unit of evolution).
 *
 * This is the agent *configuration* the RSI optimises — config-RSI, not
 * code-RSI. It is stored as opaque JSON (`strategy_dna`) on the Rust side
 * of the boundary; the schema lives here in the sidecar. Categorical
 * fields (`promptTemplateId`, `systemPromptId`, `retrievalStrategy`) are
 * indices/enums into versioned pools; the rest are bounded reals/ints.
 */

export const RETRIEVAL_STRATEGIES = ["episodic", "semantic", "graph", "hybrid"] as const;
export type RetrievalStrategy = (typeof RETRIEVAL_STRATEGIES)[number];

export interface GenomeConfig {
  /** Index into the versioned prompt-template pool. */
  promptTemplateId: number;
  /** Sampling temperature; bounded by the active provider (≤ 1.0 on Anthropic). */
  temperature: number;
  /** Index into the versioned system-prompt pool. */
  systemPromptId: number;
  retrievalStrategy: RetrievalStrategy;
  /** Fraction of available context to use; bounded [0.1, 0.95]. */
  contextWindowUsage: number;
  /** Per-tool preference, a point on the simplex (sums to 1). */
  toolPreferenceWeights: number[];
  /** How many sub-tasks to spawn; {0,1,2,3}. */
  decompositionDepth: number;
}

/**
 * Which dimensions reach the live agent (`champion.ts` projects only these).
 * Exhaustive over `GenomeConfig` on purpose: adding a dimension without
 * classifying it is a typecheck error, not a silent drop.
 *
 * Measured 13 Sep 2026: the eval harness applied all seven, the live agent
 * two. `retrievalStrategy` had no consumer on EITHER side (the L1 eval never
 * passes `recall`), and `contextWindowUsage` means "fraction of a short
 * task's budget" in eval and would mean "cap on the user's long answers"
 * live: same number, different semantics. So the dropped five are frozen
 * out of mutation (`mutation.ts` derives `MUTABLE_FIELDS` from this table)
 * rather than wired through: eval stops paying tokens to score knobs the
 * user never feels. Freezing mutation is not enough on its own — the seeds
 * differ on these fields and crossover / taste still move them — so the eval
 * grades a dropped dimension at its neutral value (`invoke-agent.ts`). To
 * un-freeze one, give it a live consumer first, then flip it here.
 */
export const LIVE_REACH: Readonly<Record<keyof GenomeConfig, "applied" | "dropped">> = {
  temperature: "applied",
  systemPromptId: "applied",
  promptTemplateId: "dropped",
  retrievalStrategy: "dropped",
  contextWindowUsage: "dropped",
  toolPreferenceWeights: "dropped",
  decompositionDepth: "dropped",
};

/** Dimensions eval varies and scores, that the live agent then ignores. */
export function droppedDimensions(): (keyof GenomeConfig)[] {
  return (Object.keys(LIVE_REACH) as (keyof GenomeConfig)[])
    .filter((k) => LIVE_REACH[k] === "dropped")
    .sort();
}

/** Dimensions that reach the live agent, in declaration order. */
export function appliedDimensions(): (keyof GenomeConfig)[] {
  return (Object.keys(LIVE_REACH) as (keyof GenomeConfig)[]).filter((k) => LIVE_REACH[k] === "applied");
}
