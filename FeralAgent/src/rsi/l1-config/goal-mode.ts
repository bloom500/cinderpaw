/**
 * Faza 1 — Async RSI Engine: Goal Mode orchestrator.
 *
 * The composition root and autonomous driver. The handlers (recorder,
 * ratchet, selection, recalcitrance) are wired onto the bus by the
 * caller before this runs; GoalMode adds the work queue + budget
 * bookkeeping and drives evaluation until a StopReason.
 *
 * Concurrency: the engine reads `pop.concurrency` on every refill of
 * the worker pool, so the live `rsi_set_concurrency` Tauri command
 * takes effect within one eval cycle without restarting the loop.
 * Lowering concurrency does NOT cancel in-flight evals — they finish
 * naturally and the pool drains to the new ceiling. Raising concurrency
 * fills new slots on the next slot-free callback. The cap is intentionally
 * soft; "kill in-flight eval" semantics can layer on top via a per-eval
 * cancellation token in a future phase.
 */

import type { EventBus, RsiEvent } from "../infra/event-bus.ts";
import type { EvalWorker } from "../infra/eval-worker.ts";
import type { BestRecord, PopulationManager } from "./population-manager.ts";
import { estimateUsd } from "../infra/rsi-cost.ts";
import { RsiRunAbortedError } from "../infra/run-eval.ts";
import { AutonomousSpendDeniedError } from "../../egress/inference-spend-authority.ts";

export interface GoalConfig {
  /** Free-text objective (carried for the UI / lineage; not used in control). */
  goal: string;
  /** Hard stop on iteration count. */
  maxIterations: number;
  /** Hard stop on cumulative token cost. */
  maxTotalTokens: number;
  /** Optional hard stop on cumulative USD cost. undefined ⇒ no cost cap.
   *  0 ⇒ local-only (any nonzero spend halts). */
  maxTotalCostUsd?: number;
  /** Blended $/1k tokens for the active model. 0 ⇒ local/free. */
  pricePer1kUsd?: number;
  /** Authoritative settled spend from the live routing boundary. When
   * present it supersedes the boot-time blended estimate. */
  currentCostUsd?: () => number;
  /** Stop early once best-all-time reaches this score. */
  targetScore?: number;
  /** Stop after this many consecutive iterations without an improvement. */
  plateauPatience?: number;
  /** Optional hard stop on wall-clock time (ms) since run() started. The
   *  Dream Cycle's primary episode cap: bounds an episode in time so it
   *  cannot hang and can't burn tokens past its window. undefined ⇒ no
   *  wall-clock cap. */
  maxWallClockMs?: number;
  /** Clock source for the wall-clock cap. Injectable so the cap is
   *  deterministic in tests. Default: Date.now. */
  now?: () => number;
  /** Shared run cancellation, independent from whether a USD cap exists. */
  signal?: AbortSignal;
  abort?: (reason: StopReason | Error) => void;
}

export type StopReason =
  | "TargetReached"
  | "BudgetExhausted"
  | "CostBudgetExhausted"
  | "SpendAuthorizationDenied"
  | "MaxIterations"
  | "PlateauPersistent"
  | "WallClockExhausted"
  | "UserStopped"
  | "Converged";

export interface GoalResult {
  reason: StopReason;
  iterations: number;
  best: BestRecord | null;
  totalTokens: number;
  totalCostUsd: number;
  /** Error messages from failed evals (capped at 5 to avoid unbounded growth). */
  errors: string[];
}

/** Pure cost-cap decision. `cap` undefined ⇒ never; `cap === 0` ⇒ stop on any
 *  spend (local stays at 0 so it runs forever); `cap > 0` ⇒ stop at/above cap. */
export function costStop(totalCostUsd: number, cap: number | undefined): boolean {
  if (cap === undefined) return false;
  if (cap === 0) return totalCostUsd > 0;
  return totalCostUsd >= cap;
}

/**
 * Subscribe the population recorder to EvalComplete. MUST be attached
 * before the selection handler so the freshly-evaluated genome's shared
 * fitness is visible when selection picks a parent in the same cascade.
 */
export function attachPopulationRecorder(bus: EventBus, pop: PopulationManager): void {
  bus.on("EvalComplete", (e: RsiEvent) => {
    pop.recordEval(e.genomeId as string, {
      fitnessScore: e.score as number,
      behavioralFingerprint: (e.behavioralFingerprint as number[]) ?? [],
    });
  });
}

export class GoalMode {
  private readonly queue: string[] = [];
  private totalTokens = 0;
  private totalCostUsd = 0;
  private userStopped = false;
  private readonly errors: string[] = [];
  /** Wall-clock deadline (epoch-ms per config.now), set at run() start
   *  when config.maxWallClockMs is given. null ⇒ no wall-clock cap. */
  private deadline: number | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly pop: PopulationManager,
    private readonly evalWorker: EvalWorker,
    private readonly config: GoalConfig,
  ) {
    // Seed the work queue with the genomes already in the population.
    this.queue.push(...pop.alive().map((g) => g.id));
    // Newly-born candidates join the queue.
    bus.on("GenomeBorn", (e: RsiEvent) => {
      this.queue.push(e.genomeId as string);
    });
    // Budget bookkeeping.
    bus.on("EvalComplete", (e: RsiEvent) => {
      const tokens = (e.tokenCost as number) ?? 0;
      this.totalTokens += tokens;
      this.totalCostUsd += estimateUsd(tokens, this.config.pricePer1kUsd ?? 0);
      if (e.errored === true && e.error && this.errors.length < 5) {
        this.errors.push(String(e.error));
      }
    });
  }

  /** Request a graceful stop; honoured at the next loop check. */
  stop(): void {
    this.userStopped = true;
    this.config.abort?.("UserStopped");
  }

  /**
   * Drive the engine until a StopReason. Worker pool with up to
   * `pop.concurrency` parallel evals.
   *
   * Iteration counting is event-driven (via the EvalComplete bus
   * subscription we install below) — the parallel pool just runs as
   * many evals as it can hold, and the count lands whenever they
   * finish. This decouples counting from the pool mechanics and is
   * the same semantic the serial loop had (count after completion),
   * which the existing tests depend on.
   */
  async run(): Promise<GoalResult> {
    let iterations = 0;
    let lastBest = -Infinity;
    let sinceImprovement = 0;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    // Arm the wall-clock deadline relative to the start of this run, using
    // the injected clock so the cap is deterministic in tests.
    if (this.config.maxWallClockMs != null) {
      this.deadline = (this.config.now ?? Date.now)() + this.config.maxWallClockMs;
      if (this.config.abort) {
        deadlineTimer = setTimeout(() => {
          if (!this.config.signal?.aborted) this.config.abort?.("WallClockExhausted");
        }, this.config.maxWallClockMs);
      }
    }

    // Event-driven iteration + best-score tracking. Registered here
    // (rather than in the constructor) so it doesn't fire for evals
    // initiated before this run() call — keeps test invariants tight.
    const offComplete = this.bus.onDisposable("EvalComplete", (e: RsiEvent) => {
      iterations += 1;
      const score = e.score as number;
      if (score > lastBest) {
        lastBest = score;
        sinceImprovement = 0;
      } else {
        sinceImprovement += 1;
      }
    });

    try {
      let stopReason: StopReason | null = null;
      const inFlight = new Set<Promise<void>>();
      const halt = (reason: StopReason): void => {
        if (stopReason !== null) return;
        stopReason = reason;
        if (!this.config.signal?.aborted) this.config.abort?.(reason);
      };

      // Launch one eval. Returns the promise (added to inFlight) or
      // null if the genome id was stale. The cleanup chain removes
      // itself from inFlight and tries to refill one slot — that
      // pickup is what makes live `pop.concurrency` changes take
      // effect on the next opportunity.
      const launch = (genomeId: string): Promise<void> | null => {
        const genome = this.pop.get(genomeId);
        if (!genome) return null;
        const p = this.evalWorker
          .run(genome)
          .catch((err) => {
            if (err instanceof RsiRunAbortedError) return;
            // The eval worker already catches its own errors and
            // emits a terminal EvalComplete (errored: true); this
            // catch is belt-and-braces for programmer-introduced
            // bugs that escape the worker. Don't let an unhandled
            // rejection tear down the pool.
            // eslint-disable-next-line no-console
            console.error("goal-mode: unhandled eval error", err);
          })
          .finally(() => {
            inFlight.delete(p);
            refill();
          });
        inFlight.add(p);
        return p;
      };

      // Fill the pool up to the current ceiling. Called at start AND
      // after every slot-free (above). No-op once stopReason is set,
      // so the tail of the pool drains to zero without further launches.
      const refill = (): void => {
        if (stopReason !== null) return;
        if (this.userStopped) {
          halt("UserStopped");
          return;
        }
        const maxN = Math.max(0, this.pop.concurrency || 1);
        while (inFlight.size < maxN) {
          const reason = this.checkStop(iterations, sinceImprovement);
          if (reason) { halt(reason); return; }
          if (this.queue.length === 0) return; // nothing to launch; pool drains naturally
          const nextId = this.queue.shift()!;
          const p = launch(nextId);
          if (p === null) continue; // pop.get returned undefined — skip
        }
      };

      // Prime the pump, then wait for the pool to empty or a stop to fire.
      refill();
      while (inFlight.size > 0) {
        // userStopped can flip on the bus thread (a handler called
        // gm.stop()); surface it as stopReason so we exit and drain.
        if (this.userStopped && stopReason === null) {
          halt("UserStopped");
        }
        if (stopReason !== null) break;
        // Race on whichever in-flight promise resolves next. allSettled
        // shape (never throws) means the loop continues until empty.
        await Promise.race(inFlight);
      }

      // A terminal reason aborts run-scoped inference. Wait only for the
      // cancellation-aware workers to unwind; they do not emit fake scores.
      if (inFlight.size > 0) await Promise.allSettled(inFlight);

      const finalReason: StopReason =
        stopReason ??
        (this.queue.length === 0 ? "Converged" : (this.checkStop(iterations, sinceImprovement) ?? "Converged"));
      return this.result(finalReason, iterations);
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      offComplete();
    }
  }

  private checkStop(iterations: number, sinceImprovement: number): StopReason | null {
    if (this.userStopped) return "UserStopped";
    if (this.config.signal?.aborted) return abortStopReason(this.config.signal.reason);
    const best = this.pop.best();
    if (this.config.targetScore != null && best && best.score >= this.config.targetScore) {
      return "TargetReached";
    }
    if (this.totalTokens >= this.config.maxTotalTokens) return "BudgetExhausted";
    if (costStop(this.currentCostUsd(), this.config.maxTotalCostUsd)) return "CostBudgetExhausted";
    if (this.deadline !== null && (this.config.now ?? Date.now)() >= this.deadline) {
      return "WallClockExhausted";
    }
    if (iterations >= this.config.maxIterations) return "MaxIterations";
    if (this.config.plateauPatience != null && sinceImprovement >= this.config.plateauPatience) {
      return "PlateauPersistent";
    }
    return null;
  }

  private result(reason: StopReason, iterations: number): GoalResult {
    return {
      reason,
      iterations,
      best: this.pop.best(),
      totalTokens: this.totalTokens,
      totalCostUsd: this.currentCostUsd(),
      errors: this.errors,
    };
  }

  private currentCostUsd(): number {
    return this.config.currentCostUsd?.() ?? this.totalCostUsd;
  }
}

function abortStopReason(reason: unknown): StopReason {
  if (reason instanceof AutonomousSpendDeniedError) {
    return reason.reason === "unknown_price" ? "SpendAuthorizationDenied" :
      reason.reason === "budget" ? "CostBudgetExhausted" : "UserStopped";
  }
  if (typeof reason === "string" && STOP_REASONS.has(reason as StopReason)) {
    return reason as StopReason;
  }
  return "UserStopped";
}

const STOP_REASONS = new Set<StopReason>([
  "TargetReached",
  "BudgetExhausted",
  "CostBudgetExhausted",
  "SpendAuthorizationDenied",
  "MaxIterations",
  "PlateauPersistent",
  "WallClockExhausted",
  "UserStopped",
  "Converged",
]);
