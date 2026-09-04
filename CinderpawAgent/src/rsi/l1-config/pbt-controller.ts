/**
 * Faza 3.5 — Meta-RSI via PBT (Population-Based Training).
 *
 * The second recursive layer: it optimises *how* the Level-1 search
 * searches. A small population of strategy-genomes — the four bootstrap
 * seeds — each carries a hyperparameter profile (mutation_rate,
 * population_size, selection_pressure, zoom_policy). Exactly ONE
 * strategy is active at a time; its hyperparams steer the live
 * Level-1 `SelectionDeps` (population_size → capacity, mutation_rate →
 * grammar sigma scale, selection_pressure → roulette sharpness,
 * zoom_policy.wild_explorer_pct → wildExplorerFraction).
 *
 * Why "one active at a time" and not literally parallel: the engine
 * runs a single Level-1 population. PBT's "concurrency" is simulated by
 * time-slicing — each strategy steers across the many EvalCompletes
 * between two ratchets (an "epoch"), and is credited on the
 * `RatchetAdvanced` that closes its epoch. Sync is therefore
 * event-driven (on RatchetAdvanced), exactly as the spec demands
 * ("Sync on RatchetAdvanced, not on wall-clock").
 *
 * The PBT step on each ratchet:
 *   1. credit the active strategy — ratchet_count += 1 and an
 *      efficiency fitness (EMA of scoreDelta / tokenCost — a
 *      recalcitrance-aware "improvement per token", so a strategy that
 *      keeps buying cheap improvements outranks one that burns tokens
 *      for the same delta);
 *   2. exploit/explore — the bottom `exploitFraction` of strategies
 *      (≥1) copy hyperparams from a randomly chosen top performer and
 *      perturb every field by ±`perturbation`, clamped to bounds. The
 *      exploited strategy keeps its id + ratchet_count (the DB tracks
 *      lifetime totals) but its fitness resets so the new config has to
 *      re-prove itself;
 *   3. rotate — the active pointer advances round-robin so every
 *      strategy gets a fair tenure.
 *
 * Bounded-RSI: strategy-genomes touch ONLY search hyperparams. They
 * cannot reach the metric, the eval suite, the scorer weights, the
 * budget, or the sandbox — those live in Rust, immutable to the agent.
 * The bounds here are an extra belt-and-braces clamp so a runaway
 * perturbation can't push a hyperparam to a pathological value.
 *
 * This module is pure: deterministic given its injected rng, no I/O.
 * The sidecar wires it to the bus (credit on RatchetAdvanced), persists
 * the strategy population to the DB + `meta/pbt_state.json`, and feeds
 * `activeHyperparams()` into the live `SelectionDeps` via accessors.
 */

/** The hyperparameter profile a strategy-genome carries. Mirrors the
 *  `StrategyGenomeSeed.hyperparams` shape in `strategy-seeds.ts`. */
export interface StrategyHyperparams {
  mutation_rate: number;
  population_size: number;
  selection_pressure: number;
  zoom_policy: {
    coarse_threshold_high: number;
    coarse_threshold_low: number;
    fine_threshold_high: number;
    fine_threshold_low: number;
    wild_explorer_pct: number;
  };
}

/** A strategy-genome: a hyperparam profile plus its running stats. */
export interface StrategyGenome {
  id: string;
  hyperparams: StrategyHyperparams;
  /** Lifetime ratchets credited while this strategy was active. */
  ratchetCount: number;
  /** EMA of efficiency (scoreDelta / tokenCost). Reset on exploit. */
  fitness: number;
}

/** Per-field hard bounds applied after every perturbation. */
export interface HyperparamBounds {
  mutation_rate: [number, number];
  population_size: [number, number];
  selection_pressure: [number, number];
  threshold: [number, number]; // applies to every zoom_policy threshold
  wild_explorer_pct: [number, number];
}

export const DEFAULT_HYPERPARAM_BOUNDS: HyperparamBounds = {
  mutation_rate: [0.01, 0.8],
  population_size: [4, 64],
  selection_pressure: [0.1, 3.0],
  threshold: [1, 32],
  wild_explorer_pct: [0.0, 0.5],
};

export interface PbtControllerDeps {
  /** The strategy population (typically the four bootstrap seeds).
   *  Mutated in place — pass a copy if the caller needs the originals. */
  strategies: StrategyGenome[];
  /** Uniform [0,1) source for donor pick + perturbation. */
  rng: () => number;
  /** Bottom fraction of the population to exploit-replace on each sync.
   *  Clamped to ≥1 strategy when > 0. Default 0.2. Set 0 to disable
   *  replacement (rotation + crediting only). */
  exploitFraction?: number;
  /** Relative perturbation magnitude (±fraction) on explore. Default 0.2. */
  perturbation?: number;
  /** Per-field clamp bounds. Default DEFAULT_HYPERPARAM_BOUNDS. */
  bounds?: HyperparamBounds;
  /** EMA smoothing for the efficiency fitness. Default 0.5. */
  fitnessAlpha?: number;
}

/** One strategy that was exploit-replaced this sync. */
export interface PbtReplacement {
  /** The strategy whose hyperparams were overwritten. */
  id: string;
  /** The top performer it copied from. */
  donorId: string;
}

/** The outcome of one `recordRatchet` PBT step — emitted as the
 *  `PBTSyncTriggered` event payload and persisted by the sidecar. */
export interface PbtSyncResult {
  /** The strategy that was credited for this ratchet (the one that was
   *  active when the ratchet fired). */
  creditedId: string;
  /** Strategies whose hyperparams were exploit-replaced this sync. */
  replaced: PbtReplacement[];
  /** The id of the strategy now active (after rotation). */
  nextActiveId: string;
}

/** Tiny epsilon so a zero-token ratchet still yields a finite, positive
 *  efficiency sample rather than Infinity / NaN. */
const TOKEN_EPSILON = 1;

export class PbtController {
  private readonly strats: StrategyGenome[];
  private readonly rng: () => number;
  private readonly exploitFraction: number;
  private readonly perturbation: number;
  private readonly bounds: HyperparamBounds;
  private readonly alpha: number;
  private activeIndex = 0;

  constructor(deps: PbtControllerDeps) {
    if (deps.strategies.length === 0) {
      throw new Error("PbtController: needs at least one strategy-genome");
    }
    this.strats = deps.strategies;
    this.rng = deps.rng;
    this.exploitFraction = deps.exploitFraction ?? 0.2;
    this.perturbation = deps.perturbation ?? 0.2;
    this.bounds = deps.bounds ?? DEFAULT_HYPERPARAM_BOUNDS;
    this.alpha = deps.fitnessAlpha ?? 0.5;
  }

  /** The strategy currently steering the Level-1 search. */
  active(): StrategyGenome {
    return this.strats[this.activeIndex]!;
  }

  /** The active strategy's hyperparams — fed live into SelectionDeps. */
  activeHyperparams(): StrategyHyperparams {
    return this.active().hyperparams;
  }

  /** A snapshot of the whole strategy population (live references). */
  strategies(): StrategyGenome[] {
    return this.strats;
  }

  /**
   * Credit the active strategy for a ratchet, run the PBT exploit/
   * explore step, and rotate the active pointer. Returns a summary for
   * the `PBTSyncTriggered` event + DB persistence.
   */
  recordRatchet(ratchet: { scoreDelta: number; tokenCost: number }): PbtSyncResult {
    const credited = this.active();
    credited.ratchetCount += 1;
    const sample = Math.max(0, ratchet.scoreDelta) / Math.max(ratchet.tokenCost, TOKEN_EPSILON);
    credited.fitness = this.alpha * sample + (1 - this.alpha) * credited.fitness;

    const replaced = this.exploitExplore();
    this.activeIndex = (this.activeIndex + 1) % this.strats.length;

    return {
      creditedId: credited.id,
      replaced,
      nextActiveId: this.active().id,
    };
  }

  /**
   * The exploit/explore step. Ranks strategies by fitness (desc); the
   * bottom `nReplace` copy hyperparams from a random top performer and
   * perturb. Returns the replacements made (empty when disabled or when
   * the population is too small to have disjoint top/bottom pools).
   */
  private exploitExplore(): PbtReplacement[] {
    const n = this.strats.length;
    if (this.exploitFraction <= 0 || n < 2) return [];

    const nReplace = Math.max(1, Math.floor(n * this.exploitFraction));
    // Top and bottom pools must be disjoint, so never replace more than
    // half the population.
    const k = Math.min(nReplace, Math.floor(n / 2));
    if (k <= 0) return [];

    // Tie-break on the RNG, not on array position. Every strategy starts at
    // fitness 0, and a stable sort then leaves them in insertion order — so on
    // the first cycles the first k seeds were ALWAYS the "winners" and the last
    // k were always overwritten with perturbations of them. A search whose job
    // is to explore was choosing by position and calling it selection.
    const ranked = [...this.strats].sort(
      (a, b) => b.fitness - a.fitness || (this.rng() < 0.5 ? -1 : 1),
    );
    const topPool = ranked.slice(0, k);
    const bottomPool = ranked.slice(n - k);

    const replaced: PbtReplacement[] = [];
    for (const loser of bottomPool) {
      const donor = topPool[Math.floor(this.rng() * topPool.length)] ?? topPool[0]!;
      if (donor.id === loser.id) continue; // never copy from self
      loser.hyperparams = this.perturb(donor.hyperparams);
      loser.fitness = 0; // re-prove the new config
      replaced.push({ id: loser.id, donorId: donor.id });
    }
    return replaced;
  }

  /** Copy `src` and perturb each numeric field by ±perturbation,
   *  clamped to bounds. population_size + thresholds are kept integral. */
  private perturb(src: StrategyHyperparams): StrategyHyperparams {
    const jitter = (v: number, [lo, hi]: [number, number], integral = false): number => {
      const factor = 1 + this.perturbation * (this.rng() * 2 - 1);
      const out = clamp(v * factor, lo, hi);
      return integral ? Math.round(out) : out;
    };
    return {
      mutation_rate: jitter(src.mutation_rate, this.bounds.mutation_rate),
      population_size: jitter(src.population_size, this.bounds.population_size, true),
      selection_pressure: jitter(src.selection_pressure, this.bounds.selection_pressure),
      zoom_policy: {
        coarse_threshold_high: jitter(src.zoom_policy.coarse_threshold_high, this.bounds.threshold, true),
        coarse_threshold_low: jitter(src.zoom_policy.coarse_threshold_low, this.bounds.threshold, true),
        fine_threshold_high: jitter(src.zoom_policy.fine_threshold_high, this.bounds.threshold, true),
        fine_threshold_low: jitter(src.zoom_policy.fine_threshold_low, this.bounds.threshold, true),
        wild_explorer_pct: jitter(src.zoom_policy.wild_explorer_pct, this.bounds.wild_explorer_pct),
      },
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
