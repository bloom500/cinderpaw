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

import type { GateDecision, PairedSample } from "./confidence.ts";
import type { EventBus, RsiEvent } from "./event-bus.ts";
import type { EvalOutcome } from "./eval-worker.ts";
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
  /** BRSI §2.7 confidence gate. Optional: when supplied, a candidate is
   *  only offered to `ratchetAttempt` if it clears the gate against the
   *  current champion's per-task outcomes (INVARIANT I6). When absent,
   *  the handler behaves exactly as Faza 1 (Rust strict-greater alone).
   *  The gate is skipped for the first candidate — there is no champion
   *  to compare against yet — so the very first ratchet bootstraps the
   *  baseline. */
  evaluateGate?: (samples: readonly PairedSample[]) => GateDecision;
}

/** Pair the current candidate's per-task outcomes against the champion's,
 *  matched by `taskId`. Each task contributes a paired sample with the
 *  per-task binary score (1 on success, 0 otherwise) — the same scalar
 *  the behavioral fingerprint uses. Tasks present in only one set are
 *  dropped: a paired test needs both measurements. Pure + deterministic.
 *
 *  Exported for `tests/rsi-ratchet-with-confidence.test.ts`. */
export function buildPairedSamples(
  candidate: readonly EvalOutcome[],
  baseline: readonly EvalOutcome[],
): PairedSample[] {
  const baseById = new Map<string, EvalOutcome>();
  for (const o of baseline) baseById.set(o.taskId, o);

  const samples: PairedSample[] = [];
  for (const c of candidate) {
    const b = baseById.get(c.taskId);
    if (b === undefined) continue;
    samples.push({
      candidate: c.success ? 1 : 0,
      baseline: b.success ? 1 : 0,
    });
  }
  return samples;
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

  /** Per-task outcomes of the current champion — the baseline the
   *  confidence gate pairs the next candidate against. Set only when a
   *  candidate actually advances main (becomes the champion). Undefined
   *  until the first ratchet: the first candidate has no baseline and so
   *  bypasses the gate. Not persisted across restarts in v1 — a fresh
   *  process re-bootstraps its baseline on the first ratchet. */
  private lastChampionOutcomes?: readonly EvalOutcome[];

  private async onEvalComplete(event: RsiEvent): Promise<void> {
    if (event.errored === true) return; // never ratchet a crashed eval

    const genomeId = event.genomeId as string;
    const score = event.score as number;
    const outcomes = event.outcomes as EvalOutcome[] | undefined;

    const { commitHash } = await this.deps.commitGenome({
      genomeId,
      score,
      tokenCost: (event.tokenCost as number) ?? 0,
      durationMs: (event.durationMs as number) ?? 0,
    });
    // Record the hash + config so the LCA adapter and the taste
    // miner can resolve `id → commit_hash → GenomeConfig` later
    // without re-reading the git substrate. Done before
    // `ratchetAttempt` so it's visible regardless of whether main
    // advances.
    if (this.pop) {
      this.pop.setCommitHash(genomeId, commitHash);
      const g = this.pop.get(genomeId);
      if (g?.config) {
        this.pop.setCommitConfig(commitHash, g.config);
      }
    }

    // BRSI §2.7 confidence gate (INVARIANT I6): before asking Rust to
    // ratchet, require statistical evidence the candidate genuinely beats
    // the champion — not just a noisy +0.001. Gated on having both a gate
    // dep and a champion baseline; the first candidate has neither and so
    // falls through to the Rust strict-greater check alone.
    if (this.deps.evaluateGate && this.lastChampionOutcomes && outcomes) {
      const samples = buildPairedSamples(outcomes, this.lastChampionOutcomes);
      const decision = this.deps.evaluateGate(samples);
      if (!decision.accept) {
        // Reject: the candidate stays on its branch (already committed
        // above) but main does not advance. No RatchetAdvanced emitted.
        return;
      }
    }

    const result = await this.deps.ratchetAttempt(commitHash, score);

    if (result.advanced) {
      // This candidate is the new champion — its outcomes become the
      // baseline the next candidate's confidence gate pairs against.
      if (outcomes) this.lastChampionOutcomes = outcomes;
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
