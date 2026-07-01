/**
 * Faza 1 — Async RSI Engine: the ratchet handler.
 *
 * On each EvalComplete it runs the candidate through the Evolution
 * Contract FSM (`runContract`, BRSI §2.1) with leaves built over the
 * injected ratchet primitives (`contractLeavesFromRatchet`). The FSM
 * sequences commit → tier-0 floor → benchmark → confidence gate (I6) →
 * ratchet attempt, and writes ONE per-candidate Journal row per terminal
 * (I3/I4). The monotonicity guarantee — `main` advances ONLY when the new
 * score beats the prior best — still lives in Rust (`ratchet_attempt`);
 * this handler reacts to the contract's verdict and emits RatchetAdvanced
 * when main moved, ConfidenceFailed when a pre-ratchet gate blocked.
 *
 * The git operations are injected so the ratchet decision is testable
 * without a live repo; in production they are protocol-(a) requests to
 * the Rust `rsi_commit_genome` / `rsi_ratchet_attempt` commands.
 */

import type { GateDecision, PairedSample } from "./confidence.ts";
import type { EventBus, RsiEvent } from "./event-bus.ts";
import type { EvalOutcome } from "./eval-worker.ts";
import type { PopulationManager } from "./population-manager.ts";
import { makeInitialState } from "./contract.ts";
import { runContract } from "./contract-runner.ts";
import { contractDepsFrom } from "./contract-deps.ts";
import {
  contractLeavesFromRatchet,
  gateForCandidate,
  type CandidateContext,
  type CandidateRun,
} from "./contract-leaves.ts";
import { DEFAULT_BUDGET_CAPS } from "./budget.ts";

// Re-exported from their new home so existing importers/tests keep working.
export { tier0FloorBreach, buildPairedSamples } from "./contract-leaves.ts";

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
  /** Cycle id stamped on each per-candidate Journal row, linking the
   *  candidate to its Dream episode. Default: "c-live" (manual runs). */
  cycleId?: () => string;
  /** Journal path override for the per-candidate rows — inject a scratch
   *  path in tests. Default: the production per-UTC-day journal. */
  journalPath?: () => string;
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
    const tokenCost = (event.tokenCost as number) ?? 0;

    const ctx: CandidateContext = {
      genomeId,
      score,
      tokenCost,
      durationMs: (event.durationMs as number) ?? 0,
      ...(outcomes ? { outcomes } : {}),
      ...(this.lastChampionOutcomes ? { championOutcomes: this.lastChampionOutcomes } : {}),
      // Record the hash + config so the LCA adapter and the taste miner
      // can resolve `id → commit_hash → GenomeConfig` later without
      // re-reading the git substrate. Fired from the sandbox_apply leaf,
      // i.e. before any verdict — visible regardless of promotion.
      onCommitted: (commitHash) => {
        if (!this.pop) return;
        this.pop.setCommitHash(genomeId, commitHash);
        const g = this.pop.get(genomeId);
        if (g?.config) {
          this.pop.setCommitConfig(commitHash, g.config);
        }
      },
    };

    const run: CandidateRun = {};
    const contractDeps = contractDepsFrom(contractLeavesFromRatchet(this.deps, ctx, run), {
      evaluateConfidence: gateForCandidate(this.deps, ctx),
      ...(this.deps.journalPath ? { journalPath: this.deps.journalPath } : {}),
    });

    const final = await runContract(
      makeInitialState({
        cycleId: this.deps.cycleId?.() ?? "c-live",
        candidateId: genomeId,
        layer: "L1", // Configuration Evolution (BRSI §5) — config-RSI candidates
        budgetCaps: DEFAULT_BUDGET_CAPS,
      }),
      contractDeps,
    );

    if (final.decided?.action === "accept" && run.advanced && run.commitHash) {
      // This candidate is the new champion — its outcomes become the
      // baseline the next candidate's confidence gate pairs against.
      if (outcomes) this.lastChampionOutcomes = outcomes;
      await this.bus.emit({
        type: "RatchetAdvanced",
        genomeId,
        commitHash: run.commitHash,
        score,
        previousBest: run.previousBest ?? 0,
        // Carried through for the recalcitrance tracker:
        // improvement_difficulty = tokenCost / (score − previousBest).
        tokenCost,
      });
      return;
    }

    // I6 gate reject: emit ConfidenceFailed with the bootstrap evidence so
    // the rejection is counted into the episode journal and mirrored to the
    // UI (ADR-0012) — a silent return would lose the evidence the gate is
    // doing its job.
    if (final.confidence && !final.confidence.accept) {
      await this.bus.emit({
        type: "ConfidenceFailed",
        genomeId,
        reason: final.confidence.reason,
        pValue: final.confidence.bootstrap.pValue,
        effectSize: final.confidence.bootstrap.effectSize,
      });
      return;
    }

    // Tier 0 floor breach (INVARIANT I8) — surfaced the same way the
    // hand-rolled path did. A deploy decline (`ratchet declined`) stays
    // silent, exactly as before: not a gate, just strict-greater saying no.
    for (let i = final.history.length - 1; i >= 0; i--) {
      const h = final.history[i]!;
      if (h.result.ok) continue;
      if (h.stage === "tests" || h.stage === "safety_checks") {
        await this.bus.emit({ type: "ConfidenceFailed", genomeId, reason: h.result.reason });
      }
      break;
    }
  }
}
