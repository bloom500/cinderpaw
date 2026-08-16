/**
 * Faza 1 — Async RSI Engine: the eval worker.
 *
 * An independent async task that evaluates one genome and reports the
 * result through the event bus. The flow:
 *
 *   EvalStarted → runEval (the agent over the eval suite) → scoreGenome
 *   (the Rust scorer, the formula the agent cannot edit) → EvalComplete
 *
 * Both `runEval` and `scoreGenome` are injected. In production `runEval`
 * is the real agent loop over Tier 0/1/2 and `scoreGenome` is a
 * protocol-(a) request to the Rust `rsi_score` command; injecting them
 * keeps the worker unit-testable and keeps the asymmetric-trust boundary
 * intact (the worker never computes the score itself).
 */

import type { EventBus } from "./event-bus.ts";
import type { GenomeSpec } from "../l1-config/population-manager.ts";
import { RsiRunAbortedError } from "./run-eval.ts";

/** One eval-task outcome. Mirrors the Rust `rsi::EvalOutcome` wire shape,
 *  plus two TS-only observability fields (`kind`, `answered`) that never
 *  cross the bridge — `makeScoreGenomeAdapter` maps the wire explicitly. */
export interface EvalOutcome {
  taskId: string;
  tier: number;
  success: boolean;
  latencyMs: number;
  tokens: number;
  errored: boolean;
  errorMessage?: string;
  /** The spec's validator kind (e.g. "fact_lookup"). TS-side only —
   *  feeds the hallucination fitness component. */
  kind?: string;
  /** True when the agent produced a non-empty response (asserted
   *  something) — distinguishes a confident wrong answer from an
   *  abstention/empty reply. TS-side only. */
  answered?: boolean;
}

/** The scorer's verdict for a batch of outcomes. */
export interface ScoreResult {
  /** Composite eval-gate score, 0..100. */
  score: number;
}

export interface EvalWorkerDeps {
  /** Run the agent over the eval suite for `genome`, yielding per-task outcomes. */
  runEval: (genome: GenomeSpec) => Promise<EvalOutcome[]>;
  /** Score a batch of outcomes via the Rust scorer (protocol (a) in prod). */
  scoreGenome: (outcomes: EvalOutcome[]) => Promise<ScoreResult>;
}

export class EvalWorker {
  constructor(
    private readonly bus: EventBus,
    private readonly deps: EvalWorkerDeps,
  ) {}

  /** Evaluate one genome end-to-end, emitting EvalStarted then EvalComplete. */
  async run(genome: GenomeSpec): Promise<void> {
    await this.bus.emit({ type: "EvalStarted", genomeId: genome.id });

    try {
      const outcomes = await this.deps.runEval(genome);
      const { score } = await this.deps.scoreGenome(outcomes);

      await this.bus.emit({
        type: "EvalComplete",
        genomeId: genome.id,
        score,
        behavioralFingerprint: behavioralFingerprint(outcomes),
        // Full per-task outcomes: the confidence gate (BRSI §2.7) pairs
        // these against the champion's, matched by taskId. Additive field;
        // Faza 1 consumers ignore it.
        outcomes,
        tokenCost: outcomes.reduce((sum, o) => sum + o.tokens, 0),
        durationMs: outcomes.reduce((sum, o) => sum + o.latencyMs, 0),
        errored: false,
      });
    } catch (err) {
      if (err instanceof RsiRunAbortedError) throw err;
      // A crashed eval must never leave the genome in-flight forever:
      // emit a terminal EvalComplete scoring 0 so the ratchet / selection
      // handlers still fire and the population can move on.
      await this.bus.emit({
        type: "EvalComplete",
        genomeId: genome.id,
        score: 0,
        behavioralFingerprint: [],
        tokenCost: 0,
        durationMs: 0,
        errored: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Per-task score vector used for niche/diversity comparisons. A binary
 * task contributes 1 on success, 0 otherwise — an errored task counts as
 * a failure for fingerprint purposes.
 */
export function behavioralFingerprint(outcomes: EvalOutcome[]): number[] {
  return outcomes.map((o) => (o.success ? 1 : 0));
}
