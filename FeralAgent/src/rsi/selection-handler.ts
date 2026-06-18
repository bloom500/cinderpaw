/**
 * Faza 1 — Async RSI Engine: the selection/mutation handler.
 *
 * Closes the loop: an EvalComplete (a genome finished) or a GenomeDied
 * (a slot freed) is the trigger to consider birthing a new candidate.
 * If the live population is below `capacity`, it picks a parent
 * fitness-proportionate on shared_fitness, mutates the parent's config
 * with `mutateConfig` (parametric only in Faza 1), registers the child,
 * and emits GenomeBorn — which the eval worker then picks up.
 *
 * `capacity` is a parameter, not a constant: population_size is a PBT
 * hyperparameter (Faza 3.5), so the active strategy genome will own it.
 */

import type { EventBus } from "./event-bus.ts";
import type { Genome, PopulationManager } from "./population-manager.ts";
import { mutateConfig, type MutationGrammar, type Rng } from "./mutation.ts";

/** Grammar bounds without the per-call randomness sources. */
export type GrammarBounds = Omit<MutationGrammar, "rng" | "gaussian">;

export interface SelectionDeps {
  /** Target live-population size; below it, a candidate may be born. */
  capacity: number;
  bounds: GrammarBounds;
  /** Uniform source for parent selection + mutation. */
  rng: Rng;
  /** Standard-normal source for the bounded-real mutations. */
  gaussian: () => number;
  /** Fresh genome id generator. */
  newId: () => string;
}

export class SelectionMutationHandler {
  constructor(
    private readonly bus: EventBus,
    private readonly pop: PopulationManager,
    private readonly deps: SelectionDeps,
  ) {
    bus.on("EvalComplete", () => this.maybeBirth());
    bus.on("GenomeDied", () => this.maybeBirth());
  }

  private async maybeBirth(): Promise<void> {
    const alive = this.pop.alive();
    if (alive.length >= this.deps.capacity) return; // no room

    const parent = this.selectParent(alive);
    if (!parent || !parent.config) return; // nothing eligible to breed from

    const grammar: MutationGrammar = {
      ...this.deps.bounds,
      rng: this.deps.rng,
      gaussian: this.deps.gaussian,
    };
    const { child, mutationType } = mutateConfig(parent.config, grammar);

    const childId = this.deps.newId();
    this.pop.add({
      id: childId,
      generation: parent.generation + 1,
      lineage: [parent.id],
      config: child,
    });

    await this.bus.emit({
      type: "GenomeBorn",
      genomeId: childId,
      parentId: parent.id,
      generation: parent.generation + 1,
      mutationType,
      config: child,
    });
  }

  /**
   * Fitness-proportionate (roulette-wheel) selection over evaluated live
   * genomes, weighted by shared_fitness. Falls back to uniform when the
   * total shared fitness is zero. Returns null if no genome is eligible.
   */
  private selectParent(alive: Genome[]): Genome | null {
    const eligible = alive.filter((g) => g.config && g.sharedFitness !== null);
    if (eligible.length === 0) return null;

    const total = eligible.reduce((sum, g) => sum + (g.sharedFitness ?? 0), 0);
    if (total <= 0) {
      return eligible[Math.min(eligible.length - 1, Math.floor(this.deps.rng() * eligible.length))]!;
    }

    let r = this.deps.rng() * total;
    for (const g of eligible) {
      r -= g.sharedFitness ?? 0;
      if (r < 0) return g;
    }
    return eligible[eligible.length - 1]!;
  }
}
