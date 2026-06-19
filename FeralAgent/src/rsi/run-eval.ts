/**
 * Faza 1 — runEval real: the suite runner.
 *
 * Builds the `runEval` function the EvalWorker injects in production. For
 * each spec it sends the prompt to the agent, measures wall-clock
 * latency, trusts the router's token count, validates the response with
 * the deterministic `validateOutcome`, and returns one `EvalOutcome` per
 * task in spec order.
 *
 * A task that throws is caught and recorded as `errored: true` /
 * `success: false` so a single model crash never aborts the rest of the
 * suite — the scorer always sees the full batch, and the genome that
 * triggered the crash simply scores lower rather than vanishing.
 *
 * `getSpecs` and `invokeAgent` are injected: in production `getSpecs`
 * concatenates the Tier 0 specs from Rust (`rsi_get_tier0_specs`) with
 * the Tier 1/2 specs from `loadTierSpecs`, and `invokeAgent` drives the
 * real agent loop under the genome's config. Keeping them as deps makes
 * the runner unit-testable without a model.
 */

import { validateOutcome, type EvalSpec } from "./eval-spec.ts";
import type { EvalOutcome } from "./eval-worker.ts";
import type { GenomeSpec } from "./population-manager.ts";

/** One agent invocation result. `tokens` comes from the InferenceRouter
 *  (the source of truth); latency is measured by the runner. */
export interface AgentResponse {
  response: string;
  tokens: number;
}

export interface RunEvalDeps {
  /** The full eval suite for this run (Tier 0 + Tier 1/2). */
  getSpecs: () => Promise<EvalSpec[]>;
  /** Drive the agent over one prompt under `genome`'s config. */
  invokeAgent: (prompt: string, genome: GenomeSpec) => Promise<AgentResponse>;
  /** Monotonic clock for latency, injectable for tests. Default Date.now. */
  now?: () => number;
}

/** Build the production `runEval` (the EvalWorker's injected suite runner). */
export function makeRunEval(
  deps: RunEvalDeps,
): (genome: GenomeSpec) => Promise<EvalOutcome[]> {
  const now = deps.now ?? Date.now;
  return async (genome) => {
    const specs = await deps.getSpecs();
    const outcomes: EvalOutcome[] = [];
    for (const spec of specs) {
      outcomes.push(await runOne(spec, genome, deps.invokeAgent, now));
    }
    return outcomes;
  };
}

async function runOne(
  spec: EvalSpec,
  genome: GenomeSpec,
  invokeAgent: RunEvalDeps["invokeAgent"],
  now: () => number,
): Promise<EvalOutcome> {
  const start = now();
  try {
    const { response, tokens } = await invokeAgent(spec.prompt, genome);
    const latencyMs = now() - start;
    return {
      taskId: spec.id,
      tier: spec.tier,
      success: validateOutcome(spec, response, tokens, latencyMs),
      latencyMs,
      tokens,
      errored: false,
    };
  } catch (err) {
    return {
      taskId: spec.id,
      tier: spec.tier,
      success: false,
      latencyMs: now() - start,
      tokens: 0,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
