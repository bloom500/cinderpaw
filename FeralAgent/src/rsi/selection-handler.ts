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
import { type MutationGrammar, type Rng } from "./mutation.ts";
import { planBirth } from "./birth-policy.ts";
import { isWildExplorer } from "./fractal.ts";
import { regionKey, type EscapeTimeTracker } from "./escape-time.ts";
import type { CrossoverPair } from "./crossover-selection.ts";

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
  // ── Faza 2/3 reproduction (all optional; absent = Faza 1 behaviour) ──
  /** Crossover candidate provider; when it yields a pair the birth is a
   *  crossover instead of a mutation (Faza 2). */
  crossover?: { selectPairs: () => Promise<CrossoverPair[]> };
  /** Escape-time tracker; zooms the mutation grammar per region (Faza 3). */
  escapeTracker?: EscapeTimeTracker;
  /** Uniform source for the 5% wild-explorer decision (Faza 3). */
  wildExplorerRng?: Rng;
  /** Wild-explorer probability (default 0.05). */
  wildExplorerFraction?: number;
  /** Taste bias applied to the child (Faza 3 taste layer). */
  taste?: { vector: () => number[]; weight: () => number };
  /** Roulette sharpness exponent on shared_fitness (Faza 3.5 PBT
   *  hyperparameter). `weight = shared_fitness ^ pressure`. 1.0 (the
   *  default when absent) is plain fitness-proportionate; > 1 sharpens
   *  toward the fittest (exploit), < 1 flattens toward uniform
   *  (explore). Read live so the active strategy-genome owns it. */
  selectionPressure?: () => number;
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

    // Faza 3: a small fraction of births ignore the zoom/crossover policy
    // and explore wildly under the coarse grammar.
    const wild = this.deps.wildExplorerRng
      ? isWildExplorer(this.deps.wildExplorerRng, this.deps.wildExplorerFraction)
      : false;

    // Faza 2: prefer a crossover when a related+divergent pair is available
    // (skipped for wild explorers).
    let crossoverPair: CrossoverPair | null = null;
    if (this.deps.crossover && !wild) {
      crossoverPair = (await this.deps.crossover.selectPairs())[0] ?? null;
    }

    // The mutation path needs a fitness-proportionate parent; the
    // crossover path uses the pair's fitter parent for lineage anchoring.
    const parent = crossoverPair ? crossoverPair.fitter : this.selectParent(alive);
    if (!parent || !parent.config) return; // nothing eligible to breed from

    const grammar: MutationGrammar = {
      ...this.deps.bounds,
      rng: this.deps.rng,
      gaussian: this.deps.gaussian,
    };
    // Faza 3: zoom the grammar by the parent region's escape-time.
    const zoomFactor = this.deps.escapeTracker
      ? this.deps.escapeTracker.zoomFactorFor(regionKey(parent.config))
      : 1;
    const taste = this.deps.taste
      ? { vector: this.deps.taste.vector(), weight: this.deps.taste.weight() }
      : undefined;

    const plan = planBirth({ parent, base: grammar, crossoverPair, wild, zoomFactor, taste });

    const childId = this.deps.newId();
    this.pop.add({
      id: childId,
      generation: plan.generation,
      lineage: plan.lineage,
      // mutationType is captured on the Genome record so the commit
      // adapter can read it back when building the git metadata
      // (`rsi_iteration.mutation_type`): "crossover" | "wild" |
      // "parametric" (or "seed" for the bootstrap genomes).
      config: plan.config,
      mutationType: plan.mutationType,
    });

    await this.bus.emit({
      type: "GenomeBorn",
      genomeId: childId,
      parentId: parent.id,
      generation: plan.generation,
      mutationType: plan.mutationType,
      config: plan.config,
      wild: plan.wild,
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

    // Faza 3.5: the active strategy-genome's selection_pressure sharpens
    // (or flattens) the roulette. weight = shared_fitness ^ pressure;
    // pressure defaults to 1.0 (plain fitness-proportionate) when no
    // strategy is steering.
    const pressure = this.deps.selectionPressure ? this.deps.selectionPressure() : 1;
    const weightOf = (g: Genome): number =>
      Math.pow(Math.max(0, g.sharedFitness ?? 0), pressure);

    const total = eligible.reduce((sum, g) => sum + weightOf(g), 0);
    if (total <= 0) {
      return eligible[Math.min(eligible.length - 1, Math.floor(this.deps.rng() * eligible.length))]!;
    }

    let r = this.deps.rng() * total;
    for (const g of eligible) {
      r -= weightOf(g);
      if (r < 0) return g;
    }
    return eligible[eligible.length - 1]!;
  }
}
