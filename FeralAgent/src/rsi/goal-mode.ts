/**
 * Faza 1 — Async RSI Engine: Goal Mode orchestrator.
 *
 * The composition root and autonomous driver. The handlers (recorder,
 * ratchet, selection, recalcitrance) are wired onto the bus by the
 * caller before this runs; GoalMode adds the work queue + budget
 * bookkeeping and drives evaluation until a StopReason.
 *
 * Concurrency: the engine starts at 1 (the validated, sequential mode —
 * each eval's full event cascade completes before the next is pulled).
 * Raising concurrency to N is a follow-up once the loop is validated.
 */

import type { EventBus, RsiEvent } from "./event-bus.ts";
import type { EvalWorker } from "./eval-worker.ts";
import type { BestRecord, PopulationManager } from "./population-manager.ts";

export interface GoalConfig {
  /** Free-text objective (carried for the UI / lineage; not used in control). */
  goal: string;
  /** Hard stop on iteration count. */
  maxIterations: number;
  /** Hard stop on cumulative token cost. */
  maxTotalTokens: number;
  /** Stop early once best-all-time reaches this score. */
  targetScore?: number;
  /** Stop after this many consecutive iterations without an improvement. */
  plateauPatience?: number;
}

export type StopReason =
  | "TargetReached"
  | "BudgetExhausted"
  | "MaxIterations"
  | "PlateauPersistent"
  | "UserStopped"
  | "Converged";

export interface GoalResult {
  reason: StopReason;
  iterations: number;
  best: BestRecord | null;
  totalTokens: number;
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
  private userStopped = false;

  constructor(
    bus: EventBus,
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
      this.totalTokens += (e.tokenCost as number) ?? 0;
    });
  }

  /** Request a graceful stop; honoured at the next loop check. */
  stop(): void {
    this.userStopped = true;
  }

  /** Drive the engine until a StopReason. Sequential (concurrency 1). */
  async run(): Promise<GoalResult> {
    let iterations = 0;
    let lastBest = -Infinity;
    let sinceImprovement = 0;

    while (true) {
      const reason = this.checkStop(iterations, sinceImprovement);
      if (reason) return this.result(reason, iterations);
      if (this.queue.length === 0) return this.result("Converged", iterations);

      const genome = this.pop.get(this.queue.shift()!);
      if (!genome) continue;

      await this.evalWorker.run(genome);
      iterations += 1;

      const best = this.pop.best();
      if (best && best.score > lastBest) {
        lastBest = best.score;
        sinceImprovement = 0;
      } else {
        sinceImprovement += 1;
      }
    }
  }

  private checkStop(iterations: number, sinceImprovement: number): StopReason | null {
    if (this.userStopped) return "UserStopped";
    const best = this.pop.best();
    if (this.config.targetScore != null && best && best.score >= this.config.targetScore) {
      return "TargetReached";
    }
    if (this.totalTokens >= this.config.maxTotalTokens) return "BudgetExhausted";
    if (iterations >= this.config.maxIterations) return "MaxIterations";
    if (this.config.plateauPatience != null && sinceImprovement >= this.config.plateauPatience) {
      return "PlateauPersistent";
    }
    return null;
  }

  private result(reason: StopReason, iterations: number): GoalResult {
    return { reason, iterations, best: this.pop.best(), totalTokens: this.totalTokens };
  }
}
