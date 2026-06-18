/**
 * Faza 1 — Async RSI Engine: the ratchet handler.
 *
 * On each EvalComplete it commits the (non-errored) genome as a git
 * candidate and asks Rust to attempt a fast-forward of `main`. The
 * monotonicity guarantee — `main` advances ONLY when the new score beats
 * the prior best — lives in Rust (`ratchet_attempt`); this handler only
 * reacts to the verdict and emits RatchetAdvanced when main moved.
 *
 * The git operations are injected so the ratchet decision is testable
 * without a live repo; in production they are protocol-(a) requests to
 * the Rust `rsi_commit_genome` / `rsi_ratchet_attempt` commands.
 */

import type { EventBus, RsiEvent } from "./event-bus.ts";

export interface RatchetDeps {
  /** Commit `genomeId` (with its score in metadata) to its candidate
   *  branch; returns the new commit hash. */
  commitGenome: (genomeId: string, score: number) => Promise<{ commitHash: string }>;
  /** Try to fast-forward `main` to `commitHash`. Advances only if `score`
   *  beats main's prior best (decided in Rust). */
  ratchetAttempt: (
    commitHash: string,
    score: number,
  ) => Promise<{ advanced: boolean; previousBest: number }>;
}

export class RatchetHandler {
  constructor(
    private readonly bus: EventBus,
    private readonly deps: RatchetDeps,
  ) {
    bus.on("EvalComplete", (e) => this.onEvalComplete(e));
  }

  private async onEvalComplete(event: RsiEvent): Promise<void> {
    if (event.errored === true) return; // never ratchet a crashed eval

    const genomeId = event.genomeId as string;
    const score = event.score as number;

    const { commitHash } = await this.deps.commitGenome(genomeId, score);
    const result = await this.deps.ratchetAttempt(commitHash, score);

    if (result.advanced) {
      await this.bus.emit({
        type: "RatchetAdvanced",
        genomeId,
        commitHash,
        score,
        previousBest: result.previousBest,
      });
    }
  }
}
