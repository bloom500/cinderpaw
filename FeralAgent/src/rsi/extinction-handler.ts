/**
 * Faza 2 — Extinction: the anti-monoculture handler.
 *
 * Watches EvalComplete (the engine's natural cadence; the ratchet fires
 * there too) and triggers an extinction event under two conditions
 * (PLAN.md "Extinction"):
 *
 *   - adaptive: mean fingerprint similarity > `monocultureThreshold`
 *     (the population converged on one behaviour) AND a persistent
 *     plateau — no best-all-time gain for `plateauPatience` evals;
 *   - periodic fallback: every `periodicInterval` evals, so a stuck run
 *     still gets shaken up even if the adaptive trigger never fires.
 *
 * On a trigger it asks the PopulationManager who to cull
 * (`selectForExtinction` — never the Hall of Fame / main / elite), emits
 * ExtinctionTriggered, then a GenomeDied per culled genome (which the
 * selection handler picks up to refill the freed slots).
 *
 * Improvement is tracked here via `pop.best()` deltas rather than by
 * listening for RatchetAdvanced, so the handler is independent of the
 * order in which EvalComplete handlers run within a single pump.
 */

import type { EventBus } from "./event-bus.ts";
import type { PopulationManager } from "./population-manager.ts";

export interface ExtinctionDeps {
  /** Mean-similarity above which the population is "monoculture". Default 0.85. */
  monocultureThreshold?: number;
  /** Evals without a best-all-time gain before a plateau is "persistent". Default 10. */
  plateauPatience?: number;
  /** Periodic fallback: force an extinction every N evals. Default 20. */
  periodicInterval?: number;
  /** Fraction of the candidate pool to cull. Default 0.8. */
  killFraction?: number;
  /** Top-N candidates to protect by shared fitness. Default 1. */
  eliteCount?: number;
}

export class ExtinctionHandler {
  private readonly monocultureThreshold: number;
  private readonly plateauPatience: number;
  private readonly periodicInterval: number;
  private readonly killFraction: number;
  private readonly eliteCount: number;

  private lastBest = Number.NEGATIVE_INFINITY;
  private evalsSinceImprovement = 0;
  private evalsSinceExtinction = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly pop: PopulationManager,
    deps: ExtinctionDeps = {},
  ) {
    this.monocultureThreshold = deps.monocultureThreshold ?? 0.85;
    this.plateauPatience = deps.plateauPatience ?? 10;
    this.periodicInterval = deps.periodicInterval ?? 20;
    this.killFraction = deps.killFraction ?? 0.8;
    this.eliteCount = deps.eliteCount ?? 1;
    // Seed from the current best so a population already evaluated at
    // construction doesn't make the first EvalComplete look like a fresh
    // improvement — the plateau counts evals from when we start watching.
    this.lastBest = pop.best()?.score ?? Number.NEGATIVE_INFINITY;
    bus.on("EvalComplete", () => this.onEvalComplete());
  }

  private async onEvalComplete(): Promise<void> {
    this.evalsSinceExtinction += 1;

    const best = this.pop.best()?.score ?? Number.NEGATIVE_INFINITY;
    if (best > this.lastBest) {
      this.lastBest = best;
      this.evalsSinceImprovement = 0;
    } else {
      this.evalsSinceImprovement += 1;
    }

    const similarity = this.pop.meanFingerprintSimilarity();
    const plateau = this.evalsSinceImprovement >= this.plateauPatience;
    const adaptive = similarity > this.monocultureThreshold && plateau;
    const periodic = this.evalsSinceExtinction >= this.periodicInterval;

    if (adaptive) {
      await this.trigger("adaptive", similarity);
    } else if (periodic) {
      await this.trigger("periodic", similarity);
    }
  }

  private async trigger(
    reason: "adaptive" | "periodic",
    similarity: number,
  ): Promise<void> {
    const killed = this.pop.selectForExtinction({
      killFraction: this.killFraction,
      eliteCount: this.eliteCount,
    });

    // Reset the clocks regardless — even a no-op trigger (everything
    // immune) should not re-fire on every subsequent eval.
    this.evalsSinceExtinction = 0;
    this.evalsSinceImprovement = 0;
    if (killed.length === 0) return;

    await this.bus.emit({
      type: "ExtinctionTriggered",
      reason,
      similarity,
      killed,
      count: killed.length,
    });
    for (const genomeId of killed) {
      this.pop.kill(genomeId);
      await this.bus.emit({ type: "GenomeDied", genomeId, cause: "extinction" });
    }
  }
}
