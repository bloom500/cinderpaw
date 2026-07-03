/**
 * Brain Stack — slice 3: scoring + routing.
 *
 * This is the *policy* layer. Registry (S1) is data. Classifier (S2) is
 * intent. Health (S6) is observation. Cost is optimisation (separate
 * slice). BrainStack is the function that turns a user turn into a
 * `{primary, fallback}` pair — no I/O, no LLM call, no logging.
 *
 * Pure given health state: route() takes the breaker as input, asks
 * "is this id healthy?" via `stateOf()` (read-only, no side effects),
 * and returns the chosen `ModelTarget`s. The router (S4) is what
 * actually makes the call; BrainStack just decides where to aim it.
 *
 * The scoring formula (from brief §3c):
 *
 *   score(model, requirement, mode) =
 *       Σ_cap  requirement[cap] * model.capabilities[cap]
 *     - modeWeight(mode) * model.cost
 *     + (mode==="budget" && model.local ? localBonus : 0)
 *
 * Kept as a pure exported function (`scoreModel`) so tests can drive
 * the formula directly without going through route(). Tuning the
 * weights later (config-driven scoring, learned weights, …) is a
 * matter of editing this function — nothing else moves.
 *
 * Rule order in route() (mirrors the brief):
 *   1. classify the input
 *   2. look up the category's REQUIREMENTS vector
 *   3. filter the registry to `available(isHealthy)` — configured AND
 *      not currently tripped-open in the breaker
 *   4. if the category has an `overrides` entry AND that model is
 *      available → it becomes the primary (overrides the scorer)
 *   5. else if the category is "offline" AND `cfg.offlineModelId` is
 *      available → force it as primary
 *   6. else → score every candidate and pick the top scorer
 *   7. fallback = next-best (preferring a different provider family so
 *      the same outage doesn't take out both targets)
 *
 * If no candidate is available after step 3, route() throws
 * `BrainError` — it never silently picks a broken model. The caller
 * surfaces the error to the user (or falls back to the default path
 * via `brain?.enabled` in S5).
 */

import type { CircuitBreaker } from "../sandbox/circuit-breaker.ts";
import type { ModelTarget } from "../types.ts";
import {
  CapabilityRegistry,
  type BrainModel,
  type Capability,
  type Category,
} from "./capability-registry.ts";
import { classify, type Classification } from "./task-classifier.ts";

// ---------------------------------------------------------------------------
// Mode + requirement table
// ---------------------------------------------------------------------------

/**
 * How aggressively to penalise cost when picking a model. `budget`
 * avoids expensive models and prefers local. `quality` ignores cost
 * entirely — best capability wins regardless of price. `balanced` is
 * the default: capability weighted by cost.
 */
export type Mode = "budget" | "balanced" | "quality";

/** Per-mode cost penalty applied to `model.cost`. */
export const MODE_WEIGHT: Readonly<Record<Mode, number>> = {
  budget: 2.0,
  balanced: 1.0,
  quality: 0,
};

/** Bonus added to `score` for local models in `budget` mode. */
export const LOCAL_BONUS = 1.5;

/** Per-mode confidence bonus applied to score (small — tiebreaker only). */
const CONFIDENCE_WEIGHT = 0.5;

/**
 * What each category NEEDS from a model. Weights are unitless; the
 * scorer multiplies them by the model's `capabilities[cap]` (0..10) so
 * a weight of 1.0 against a capability of 10 contributes 10 to the
 * score. A weight of 0.5 contributes 5 from the same model.
 *
 * Hand-tuned for MVP. Treat as read-only — slice N will let users
 * override per-category in `brain.json` (the `overrides` field on
 * `BrainConfig` is the per-id pin; per-capability weights come later).
 */
export const REQUIREMENTS: { readonly [K in Category]: Partial<Record<Capability, number>> } = {
  coding: { coding: 1.0, reasoning: 0.5 },
  vision: { vision: 1.0 },
  reasoning: { reasoning: 1.0 },
  creative: { multilingual: 0.4, reasoning: 0.3, speed: 0.2 },
  simple: { speed: 1.0 },
  // Offline: any working model is fine; speed is just a tiebreaker
  // since the user is presumably waiting for the local engine.
  offline: { speed: 0.5 },
  multilingual: { multilingual: 1.0 },
};

// ---------------------------------------------------------------------------
// Config + result shapes
// ---------------------------------------------------------------------------

export interface BrainConfig {
  /** Brain Stack is opt-in — when false, agent-loop never calls route(). */
  enabled: boolean;
  /** Cost-vs-quality dial. Picks the scoring weights for every route. */
  mode: Mode;
  /** Static catalogue of every model Brain Stack may route to. */
  registry: BrainModel[];
  /**
   * Forced pick when classification.category === "offline". If unset
   * (or the model is unhealthy / unconfigured) scoring takes over.
   */
  offlineModelId?: string;
  /**
   * Per-category pin — when set, the named model is used as primary
   * for that category whenever it is available. Falls back to
   * scoring if the override is unavailable.
   */
  overrides?: Partial<Record<Category, string>>;
}

export interface RouteResult {
  /** What the classifier decided (slice S2). Echoed back so the caller
   *  can log / display the reasoning without re-classifying. */
  classification: Classification;
  /** The target the router should call first (always set). */
  primary: ModelTarget;
  /** Optional second choice — different provider preferred. */
  fallback?: ModelTarget;
  /** Stable id of the chosen primary; the router feeds this to the breaker. */
  chosenId: string;
}

export interface RouteInput {
  text: string;
  hasImages: boolean;
  offline: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when Brain Stack cannot produce a usable routing decision.
 *
 * Why a dedicated class: the agent loop catches this to distinguish
 * "Brain is enabled but no model can serve this turn" (surface to the
 * user as "no model configured") from `InferenceError` (the call
 * itself failed). Different recovery paths, different UX.
 */
export class BrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainError";
  }
}

// ---------------------------------------------------------------------------
// Pure scoring (exported for unit tests + future config-driven tuning)
// ---------------------------------------------------------------------------

/**
 * Compute one model's score for one (requirement, mode) pair. Pure:
 * no I/O, no breaker access, no side effects.
 *
 * Formula: `Σ w_i * c_i  -  modeWeight * cost  +  (budget && local ? bonus : 0)`
 * Plus a small confidence tiebreaker so two models with the same
 * numbers break toward the one the classifier was more sure about.
 *
 * The score can be negative (e.g. a premium model with no capability
 * coverage under a high-penalty budget mode). Sorting still works;
 * "lower is worse" doesn't matter — only the order does.
 */
export function scoreModel(
  model: BrainModel,
  requirement: Partial<Record<Capability, number>>,
  mode: Mode,
  confidence: number = 0.5,
): number {
  let s = 0;
  for (const cap of Object.keys(requirement) as Capability[]) {
    const w = requirement[cap] ?? 0;
    const c = model.capabilities[cap] ?? 0;
    s += w * c;
  }
  s -= MODE_WEIGHT[mode] * model.cost;
  if (mode === "budget" && model.local) s += LOCAL_BONUS;
  // Confidence is a small tiebreaker — the scorer is pure, so it gets
  // passed in by the caller rather than re-classifying here.
  s += CONFIDENCE_WEIGHT * confidence;
  return s;
}

// ---------------------------------------------------------------------------
// BrainStack
// ---------------------------------------------------------------------------

export class BrainStack {
  readonly #registry: CapabilityRegistry;
  readonly #mode: Mode;
  readonly #breaker: CircuitBreaker;
  readonly #overrides: Partial<Record<Category, string>>;
  readonly #offlineModelId: string | undefined;

  constructor(cfg: BrainConfig, breaker: CircuitBreaker) {
    this.#registry = new CapabilityRegistry(cfg.registry);
    this.#mode = cfg.mode;
    this.#breaker = breaker;
    this.#overrides = cfg.overrides ?? {};
    this.#offlineModelId = cfg.offlineModelId;
  }

  /** Current cost/quality dial. */
  get mode(): Mode {
    return this.#mode;
  }

  /** Read-only view of the underlying registry (for tests / diagnostics). */
  get registry(): CapabilityRegistry {
    return this.#registry;
  }

  /**
   * Pick primary + fallback for this turn.
   *
   * Steps: classify → requirement → available → override or offline or
   * score → fallback (different provider preferred) → return.
   *
   * Throws `BrainError` when no candidate is available after the
   * configured / health filter. Never returns a broken model silently.
   */
  route(input: RouteInput): RouteResult {
    const classification = classify(input);
    const requirement = REQUIREMENTS[classification.category];

    // "Healthy" here = state is not 'open'. Closed AND half-open both
    // qualify: closed is definitively healthy; half_open means the
    // cooldown expired and the breaker is ready to probe, which the
    // router does on the actual call. stateOf() is read-only — it
    // does NOT touch in-flight probes or transition states. The
    // router's complete() will do that side-effecting check() later.
    const isHealthy = (id: string): boolean =>
      this.#breaker.stateOf(id) !== "open";

    const available = this.#registry.available(isHealthy);
    if (available.length === 0) {
      throw new BrainError(
        `no models available for category "${classification.category}" ` +
          `(registry=${this.#registry.size}, all unhealthy or unconfigured)`,
      );
    }

    const primary = this.#choosePrimary(
      classification,
      requirement,
      available,
    );

    const fallback = this.#chooseFallback(
      primary,
      requirement,
      available,
      classification,
    );

    return {
      classification,
      primary: primary.target,
      fallback: fallback?.target,
      chosenId: primary.id,
    };
  }

  #choosePrimary(
    classification: Classification,
    requirement: Partial<Record<Capability, number>>,
    available: readonly BrainModel[],
  ): BrainModel {
    // 1. Category override (if set AND available) wins over everything
    //    except... well, actually override beats scoring. The whole
    //    point of an override is "I always want this for category X".
    const overrideId = this.#overrides[classification.category];
    if (overrideId !== undefined) {
      const m = available.find((x) => x.id === overrideId);
      if (m !== undefined) return m;
      // Override set but unavailable — fall through to scoring. We do
      // NOT throw here: an unavailable override is a config bug, but
      // the user's intent (route to something for this category) is
      // better served by falling back to scoring than by failing the
      // whole turn. Slice S5 will log this if a logger is wired in.
    }

    // 2. Offline-forced model (category is "offline" AND offlineModelId
    //    is set AND the model is available).
    if (
      classification.category === "offline" &&
      this.#offlineModelId !== undefined
    ) {
      const m = available.find((x) => x.id === this.#offlineModelId);
      if (m !== undefined) return m;
      // offlineModelId set but unavailable — fall through to scoring.
      // Better to answer with something working than to refuse.
    }

    // 3. Score every candidate and pick the top scorer.
    return pickTopScore(available, requirement, this.#mode, classification.confidence);
  }

  #chooseFallback(
    primary: BrainModel,
    requirement: Partial<Record<Capability, number>>,
    available: readonly BrainModel[],
    classification: Classification,
  ): BrainModel | undefined {
    // Other candidates = everyone except the primary.
    const others = available.filter((m) => m.id !== primary.id);
    if (others.length === 0) return undefined;

    // Prefer the top-scoring candidate with a DIFFERENT provider than
    // the primary. If the primary is anthropic and anthropic goes down,
    // we want openai as fallback — not another anthropic model.
    const primaryProvider = primary.target.provider;
    const scored = others
      .map((m) => ({
        m,
        s: scoreModel(m, requirement, this.#mode, classification.confidence),
      }))
      .sort((a, b) => b.s - a.s);

    const topDifferentProvider = scored.find(
      (x) => x.m.target.provider !== primaryProvider,
    );
    if (topDifferentProvider !== undefined) return topDifferentProvider.m;

    // No different-provider candidate exists; take the top scorer
    // even if it shares the primary's provider.
    return scored[0]?.m;
  }
}

// ---------------------------------------------------------------------------
// Module-internal helpers — exported only for tests.
// ---------------------------------------------------------------------------

/**
 * Find the highest-scoring candidate. Single-pass O(n) so the order
 * of `candidates` is the stable tiebreaker when scores match.
 */
export function pickTopScore(
  candidates: readonly BrainModel[],
  requirement: Partial<Record<Capability, number>>,
  mode: Mode,
  confidence: number = 0.5,
): BrainModel {
  if (candidates.length === 0) {
    // The caller (route) already checked this; defensive throw here
    // makes pickTopScore safe to export for direct testing.
    throw new BrainError("pickTopScore: empty candidate set");
  }
  let best = candidates[0]!;
  let bestScore = scoreModel(best, requirement, mode, confidence);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const s = scoreModel(c, requirement, mode, confidence);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}