/**
 * Faza 3 — Fractal Search: escape-time recorder handler.
 *
 * Subscribes to EvalComplete and feeds the EscapeTimeTracker with the
 * per-region escape-time of the lineage that just finished evaluating.
 *
 * The "region" is defined by the PARENT's config (PLAN.md "Fractal
 * Search"): the mutation was applied inside the parent's region, and
 * the escape-time of the chain that mutation produced tells us how
 * promising that region is. The current genome's own config is the
 * CHILD's region — which the next mutation will record into.
 *
 * The score chain is walked in birth order (oldest ancestor first,
 * genome itself last), and `escapeTimeOf` is computed over it. An
 * ancestor whose score is null (not yet evaluated) breaks the chain —
 * a partial chain still gives a meaningful escape-time, and a missing
 * chain entirely (bootstrap seeds) is a no-op.
 *
 * MUST be wired AFTER `attachPopulationRecorder` so the freshly-
 * evaluated genome's `fitnessScore` is visible. The engine composition
 * order (recorder → ratchet → selection → recalcitrance → extinction)
 * already places this correctly when EscapeTimeRecorder is added
 * between the population recorder and the ratchet.
 */

import type { EventBus, RsiEvent } from "./event-bus.ts";
import {
  escapeTimeOf,
  regionKey,
  type EscapeTimeTracker,
} from "./escape-time.ts";
import type { PopulationManager } from "./population-manager.ts";

export class EscapeTimeRecorder {
  constructor(
    bus: EventBus,
    private readonly pop: PopulationManager,
    private readonly tracker: EscapeTimeTracker,
  ) {
    bus.on("EvalComplete", (e) => this.onEvalComplete(e));
  }

  private onEvalComplete(event: RsiEvent): void {
    const genomeId = event.genomeId as string;
    const score = event.score as number;
    const genome = this.pop.get(genomeId);
    if (!genome || !genome.config) return;

    // Bootstrap seeds have no parent — nothing to record against.
    const parentId = genome.lineage[0];
    if (!parentId) return;

    const parent = this.pop.get(parentId);
    if (!parent || !parent.config) return;

    // Walk back through the primary (fitter-for-crossover) line of
    // descent. The chain ends at the first unevaluated ancestor — a
    // partial chain is fine; escapeTimeOf is well-defined for any
    // non-empty input.
    const chain = walkLineageScores(genome, this.pop);
    chain.push(score);

    const t = escapeTimeOf(chain);
    this.tracker.record(regionKey(parent.config), t);
  }
}

/**
 * Walk the primary lineage chain (each step follows `lineage[0]`,
 * which is the fitter parent for a crossover birth) and return the
 * recorded scores in birth order (oldest ancestor first).
 *
 * Stops at the first unevaluated ancestor (score === null) or at a
 * missing parent. The defensive visit cap guards against an accidental
 * cycle in the lineage graph — a real run cannot produce one, but a
 * buggy handler that emits GenomeBorn with its own id as lineage[0]
 * would otherwise spin forever.
 */
export function walkLineageScores(
  start: { id: string; lineage: string[]; fitnessScore: number | null },
  pop: PopulationManager,
): number[] {
  const chain: number[] = [];
  const seen = new Set<string>([start.id]);
  const parentId = start.lineage[0];
  if (!parentId) return chain;

  let cur = pop.get(parentId);
  let hops = 0;
  const MAX_HOPS = 10_000;

  while (cur && hops++ < MAX_HOPS) {
    if (seen.has(cur.id)) break; // cycle — bail
    seen.add(cur.id);
    if (cur.fitnessScore === null) break;
    chain.unshift(cur.fitnessScore);
    const pid = cur.lineage[0];
    if (!pid) break;
    cur = pop.get(pid);
  }
  return chain;
}
