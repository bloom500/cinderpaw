/**
 * Faza 4 — the LIVE `runEval` for the LoRA pipeline: paired A/B of a
 * candidate adapter against the current baseline, over the SAME eval
 * suite the config ladder uses.
 *
 * Sequence (each `setLora` stages the adapter in Rust and reloads the
 * model — see `rsi_set_lora` in `src-tauri/src/rsi/commands.rs`):
 *
 *   setLora(baseline) → run suite → setLora(candidate) → run suite
 *   → setLora(baseline)   // ALWAYS restored, even when the suite throws
 *
 * Baseline = the domain's champion adapter, or the bare foundation model
 * when there is none yet. The config genome is held CONSTANT across both
 * runs (the champion config / eval identity) so the only variable is the
 * adapter — the whole point of a paired sample.
 *
 * Scoring: one paired sample per task, matched by taskId, success as
 * 0/1 (the same deterministic `validateOutcome` verdict the ladder
 * trusts). Tier 0 comes from the CANDIDATE run's tier-0 outcomes — the
 * safety floor is about what the adapter does, not about the diff.
 * ponytail: 0/1 samples; latency/token-weighted scores if 0/1 ever
 * proves too coarse for the bootstrap.
 */

import type { PairedSample } from "./confidence.ts";
import type { EvalOutcome } from "./eval-worker.ts";
import type { Tier0Result } from "./lora-eval-gate.ts";
import type { GenomeSpec } from "./population-manager.ts";

export interface LoraEvalRunnerDeps {
  /** Stage adapter + reload model. `null` = bare foundation model. */
  setLora: (path: string | null) => Promise<void>;
  /** The suite runner (production: `makeRunEval`'s output). */
  runEval: (genome: GenomeSpec) => Promise<EvalOutcome[]>;
  /** The constant config both runs use (champion config / eval identity). */
  genome: GenomeSpec;
  /** The adapter the domain currently answers with, or null. */
  baselineAdapterPath: () => string | null;
  log?: (msg: string) => void;
}

/** Build the `runEval` function `runLoraTrainingCycle` expects. */
export function makeLoraEvalRunner(
  deps: LoraEvalRunnerDeps,
): (adapterPath: string) => Promise<{ tier0: Tier0Result; samples: PairedSample[] }> {
  return async (adapterPath) => {
    const baseline = deps.baselineAdapterPath();
    deps.log?.(
      `lora eval: candidate=${adapterPath} baseline=${baseline ?? "<foundation>"}`,
    );

    await deps.setLora(baseline);
    const baselineOutcomes = await deps.runEval(deps.genome);

    let candidateOutcomes: EvalOutcome[];
    try {
      await deps.setLora(adapterPath);
      candidateOutcomes = await deps.runEval(deps.genome);
    } finally {
      // The live model must NEVER be left answering with an unapproved
      // candidate — restore even when the candidate run throws.
      try {
        await deps.setLora(baseline);
      } catch (err) {
        deps.log?.(
          `lora eval: RESTORE FAILED — model may still carry the candidate adapter: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      tier0: tier0Of(candidateOutcomes),
      samples: pairOutcomes(candidateOutcomes, baselineOutcomes),
    };
  };
}

/** Tier 0 floor from the candidate run: every tier-0 task must succeed. */
export function tier0Of(outcomes: EvalOutcome[]): Tier0Result {
  const failed = outcomes
    .filter((o) => o.tier === 0 && !o.success)
    .map((o) => o.taskId);
  return failed.length === 0 ? { passed: true } : { passed: false, failedSpecIds: failed };
}

/** Pair candidate/baseline outcomes by taskId as 0/1 scores. Tasks that
 *  ran on only one side are dropped — an unpaired score would bias the
 *  bootstrap's paired differences. */
export function pairOutcomes(
  candidate: EvalOutcome[],
  baseline: EvalOutcome[],
): PairedSample[] {
  const base = new Map(baseline.map((o) => [o.taskId, o]));
  const samples: PairedSample[] = [];
  for (const c of candidate) {
    const b = base.get(c.taskId);
    if (!b) continue;
    samples.push({ candidate: c.success ? 1 : 0, baseline: b.success ? 1 : 0 });
  }
  return samples;
}
