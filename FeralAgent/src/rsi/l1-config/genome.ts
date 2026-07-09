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
