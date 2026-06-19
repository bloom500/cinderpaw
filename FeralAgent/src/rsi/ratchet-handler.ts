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
import type { PopulationManager } from "./population-manager.ts";

/** Everything from EvalComplete the commit adapter needs; config,
 *  lineage and mutationType are filled by the adapter from the population. */
export interface CommitRequest {
  genomeId: string;
  score: number;
  tokenCost: number;
  durationMs: number;
}

export interface RatchetDeps {
  /** Commit the genome (with its score + cost in metadata) to its
   *  candidate branch; returns the new commit hash. */
  commitGenome: (req: CommitRequest) => Promise<{ commitHash: string }>;
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
    /** The population — used to record each genome's commit hash so
     *  the LCA adapter can resolve `id → hash` later. Optional for
     *  legacy/test wiring where the lookup is not needed; in
     *  production it is always supplied. */
    private readonly pop?: PopulationManager,
  ) {
    bus.on("EvalComplete", (e) => this.onEvalComplete(e));
  }

  private async onEvalComplete(event: RsiEvent): Promise<void> {
    if (event.errored === true) return; // never ratchet a crashed eval

    const genomeId = event.genomeId as string;
    const score = event.score as number;

    const { commitHash } = await this.deps.commitGenome({
      genomeId,
      score,
      tokenCost: (event.tokenCost as number) ?? 0,
      durationMs: (event.durationMs as number) ?? 0,
    });
    // Record the hash so the LCA adapter (and any future lookup) can
    // resolve this genome without re-reading the git substrate. Done
    // before `ratchetAttempt` so it's visible regardless of whether
    // main advances.
    this.pop?.setCommitHash(genomeId, commitHash);

    const result = await this.deps.ratchetAttempt(commitHash, score);

    if (result.advanced) {
      await this.bus.emit({
        type: "RatchetAdvanced",
        genomeId,
        commitHash,
        score,
        previousBest: result.previousBest,
        // Carried through for the recalcitrance tracker:
        // improvement_difficulty = tokenCost / (score − previousBest).
        tokenCost: (event.tokenCost as number) ?? 0,
      });
    }
  }
}
