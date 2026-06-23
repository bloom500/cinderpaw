/**
 * Faza 3.5 — Meta-RSI via PBT: the bus handler.
 *
 * The seam between the Level-1 engine and the meta layer. It is the
 * ONLY thing that drives the PbtController from engine events:
 *
 *   RatchetAdvanced → credit the active strategy (scoreDelta / tokenCost)
 *                   → PBT exploit/explore + rotate (inside recordRatchet)
 *                   → emit PBTSyncTriggered (the sync summary)
 *                   → persist the strategy population (DB + pbt_state.json)
 *
 * Sync is event-driven (on RatchetAdvanced), never wall-clock — exactly
 * the spec's "Sync on RatchetAdvanced, not on wall-clock". Persistence
 * is a soft layer: a persist that throws is swallowed so a transient
 * disk error never aborts the engine's event cascade. The strategy
 * state in memory is the source of truth for the live run; the DB write
 * is for durability across restarts.
 */

import type { EventBus } from "./event-bus.ts";
import type { PbtController, StrategyGenome, PbtSyncResult } from "./pbt-controller.ts";

export interface PbtHandlerDeps {
  controller: PbtController;
  /** Durable sink for the strategy population after each sync. Called
   *  with live references — copy if you retain them. Optional; errors
   *  are caught and never propagate into the bus pump. */
  persist?: (
    strategies: StrategyGenome[],
    result: PbtSyncResult,
  ) => void | Promise<void>;
}

export class PbtHandler {
  constructor(
    private readonly bus: EventBus,
    private readonly deps: PbtHandlerDeps,
  ) {
    bus.on("RatchetAdvanced", (e) => this.onRatchet(e));
  }

  private async onRatchet(event: Record<string, unknown>): Promise<void> {
    const score = (event.score as number) ?? 0;
    const previousBest = (event.previousBest as number) ?? 0;
    const tokenCost = (event.tokenCost as number) ?? 0;

    const result = this.deps.controller.recordRatchet({
      scoreDelta: score - previousBest,
      tokenCost,
    });

    await this.bus.emit({
      type: "PBTSyncTriggered",
      creditedId: result.creditedId,
      nextActiveId: result.nextActiveId,
      replaced: result.replaced,
    });

    if (this.deps.persist) {
      try {
        await this.deps.persist(this.deps.controller.strategies(), result);
      } catch {
        // Soft layer — durability is best-effort, never fatal.
      }
    }
  }
}
