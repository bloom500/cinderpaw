/**
 * Capability registry — Brain Stack slice 1.
 *
 * The registry is the static catalogue of every model the Brain Stack can
 * route to. It is intentionally tiny: no router, no circuit breaker, no
 * scoring. Those are other slices' jobs (see docs/2026-07-03-brain-stack-minimax-brief.md).
 *
 * Three things live here:
 *   1. The `BrainModel` shape — a Brain Stack entry that wraps a real
 *      `ModelTarget` (so the registry imports the same type the router
 *      accepts — no parallel "brain-target" type).
 *   2. The `Capability` / `Category` vocabularies — Brain Stack's own
 *      routing vocabulary. Kept separate from the router's plumbing.
 *   3. `CapabilityRegistry.available(isHealthy)` — the only filter Brain
 *      Stack needs before scoring: models that are usable RIGHT NOW.
 *      A model is usable iff (it has creds OR is local) AND the circuit
 *      breaker says it's closed. Everything else is invisible to the
 *      scorer.
 *
 * Why a callback for health instead of owning the CircuitBreaker:
 *   The breaker lives in agent-loop (it already has one for tools, keyed
 *   by tool name). Generalising it to be keyed by `BrainModel.id` is a
 *   later slice (S6). Until then, Brain Stack asks "is this id healthy?"
 *   and the caller decides how to answer. Keeps this file zero-deps on
 *   the breaker — only `ModelTarget` is imported.
 */

import type { ModelTarget } from "../types.ts";

/**
 * What a model is GOOD at. Keys are stable; values are 0..10 (a "how good"
 * score, not a boolean). Brain Stack scores by Σ requirement[cap] *
 * capabilities[cap] (see brain-stack.ts slice S3).
 */
export type Capability =
  | "reasoning"
  | "coding"
  | "vision"
  | "speed"
  | "multilingual";

/**
 * What the user is asking for. The classifier (slice S2) produces one of these.
 * Routing picks the registry entry that best matches the category's
 * `REQUIREMENTS` weight vector (slice S3).
 */
export type Category =
  | "simple"
  | "coding"
  | "vision"
  | "reasoning"
  | "creative"
  | "multilingual"
  | "offline";

/**
 * A model the Brain Stack can route to. `target` reuses the REAL `ModelTarget`
 * so passing `brainModel.target` to `InferenceRouter.completeWith()` (slice S4)
 * is a no-cast straight line — the router already knows this shape.
 */
export interface BrainModel {
  /** Stable key — used as the breaker key in S6 and as the registry lookup. */
  id: string;
  /** Provider/model/baseUrl/apiKey — the real type the router accepts. */
  target: ModelTarget;
  /** 0..10 per capability. Missing keys score as 0 (defensive). */
  capabilities: Record<Capability, number>;
  /** 1 = cheap/local, 2 = mid, 3 = premium. Used by budget-mode scoring. */
  cost: 1 | 2 | 3;
  /** True iff this model runs on-device (Ollama / local llama.cpp). */
  local: boolean;
  /**
   * Tokens the model can actually hold, prompt and reply together.
   *
   * Added because the scorer had no way to know. It weighed reasoning,
   * coding, vision, speed, multilingual and cost — five judgements about how
   * GOOD a model is and not one about whether the prompt FITS. In budget mode
   * a small local model even gets a bonus, so a 4B with a 4k window was the
   * preferred answer for a turn carrying the agent's system prompt and a
   * conversation on top of it.
   *
   * A model that overruns its window does not raise: it degenerates. The
   * repeated-byte replies that look like a broken install are this, and
   * nothing in the routing path could see it coming.
   *
   * `undefined` means unknown, which is treated as "do not rule it out" —
   * refusing every model whose window nobody recorded would ground the whole
   * registry the day it shipped.
   */
  contextWindow?: number;
}

/** All capability keys, as a tuple — used to default-fill missing capabilities. */
const ALL_CAPS: readonly Capability[] = [
  "reasoning",
  "coding",
  "vision",
  "speed",
  "multilingual",
] as const;

/**
 * Models the Brain Stack may route to. The constructor validates the
 * catalogue (duplicate ids → throw; same id used by the breaker in S6).
 */
export class CapabilityRegistry {
  readonly #byId: Map<string, BrainModel>;

  constructor(models: BrainModel[]) {
    const seen = new Map<string, BrainModel>();
    for (const m of models) {
      if (seen.has(m.id)) {
        throw new Error(
          `CapabilityRegistry: duplicate model id "${m.id}"`,
        );
      }
      // Normalised on the way in. The scores are documented as 0..10 and the
      // router multiplies them by the request's weights — but nothing enforced
      // the range, and `brain.json` is a file a person edits. One `"reasoning":
      // 999` (a typo, an extra digit) and that model outscores every other for
      // every request mentioning reasoning, permanently, with the UI showing a
      // routing decision that looks deliberate. Same for `cost`, whose type
      // says 1 | 2 | 3 and whose value at runtime is whatever the JSON said.
      const capabilities = clampCapabilities(m.capabilities);
      const cost = clampCost(m.cost);
      // Keep the original object when nothing needed changing: callers compare
      // registry entries by identity, and a defensive copy for a model that was
      // already in range buys nothing and breaks that.
      seen.set(
        m.id,
        capabilities === null && cost === m.cost ? m : { ...m, ...(capabilities ? { capabilities } : {}), cost },
      );
    }
    this.#byId = seen;
  }

  /** Every model in the registry (no health / creds filtering). */
  all(): BrainModel[] {
    return [...this.#byId.values()];
  }

  /** Lookup by stable id. Returns undefined when the id isn't registered. */
  get(id: string): BrainModel | undefined {
    return this.#byId.get(id);
  }

  /** Number of models registered. Cheap; useful for tests / debug. */
  get size(): number {
    return this.#byId.size;
  }

  /**
   * Models that are usable RIGHT NOW for this turn.
   *
   * A model is usable iff ALL of:
   *   - it is `isConfigured(model)` — local engines count as configured
   *     by definition, cloud targets need a non-empty apiKey
   *   - `isHealthy(model.id)` returns true (the circuit breaker says
   *     the target is closed / half-open-but-allowable)
   *
   * Anything failing either check is invisible to the scorer. The
   * scorer is pure — it doesn't see unhealthy or unconfigured models.
   * Provider-specific readiness signals (custom auth headers, self-
   * hosted endpoints that need an extra ping) extend `isConfigured`,
   * not this method.
   */
  available(isHealthy: (id: string) => boolean): BrainModel[] {
    const out: BrainModel[] = [];
    for (const m of this.#byId.values()) {
      if (!isConfigured(m)) continue;
      // isHealthy may throw if a caller wires it to a buggy breaker; we
      // let that bubble (it's a programmer error, not a routing
      // decision). The Brain Stack's contract is "ask the breaker; if
      // the breaker is broken, surface that, don't paper over it."
      if (!isHealthy(m.id)) continue;
      out.push(m);
    }
    return out;
  }
}

/**
 * Is the model configured and able to receive a request?
 *
 * "Configured" is broader than "has API key" — it covers every provider
 * family Brain Stack will eventually see (Local, OpenAI, Anthropic,
 * Ollama, llama.cpp, LM Studio, HuggingFace endpoint, OpenAI-compatible,
 * …). A local engine is configured by definition: it has no key, doesn't
 * need one, won't 401. A cloud target is configured when it has a
 * non-empty `apiKey`. An empty string is "key was cleared" — routing to
 * such a target would just 401, so we treat it as unconfigured.
 *
 * Future provider families that have a different readiness signal (e.g. a
 * self-hosted endpoint behind auth that requires both a key AND a custom
 * header) extend this function, not the call sites.
 */
export function isConfigured(model: BrainModel): boolean {
  if (model.local) return true;
  const k = model.target.apiKey;
  return typeof k === "string" && k.length > 0;
}

/**
 * Fill missing capability keys with 0. Useful for callers that build
 * `capabilities` from a partial source (e.g. user JSON) — Brain Stack's
 * scorer treats a missing capability as "this model is bad at it".
 */
export function normalizeCapabilities(
  partial: Partial<Record<Capability, number>>,
): Record<Capability, number> {
  const out = {} as Record<Capability, number>;
  for (const cap of ALL_CAPS) {
    const v = partial[cap];
    // Deliberately NOT clamped: filling in a missing value is normalisation,
    // deciding that 42 is out of range is policy, and the two have different
    // callers. The registry clamps on the way in — see its constructor.
    out[cap] = typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  return out;
}

/**
 * Capabilities brought into the documented 0..10 range, or `null` when they
 * were already inside it (so the caller can keep the original object).
 */
function clampCapabilities(
  caps: Record<Capability, number>,
): Record<Capability, number> | null {
  let changed = false;
  const out = {} as Record<Capability, number>;
  for (const cap of ALL_CAPS) {
    const v = caps[cap];
    const safe = typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0;
    if (safe !== v) changed = true;
    out[cap] = safe;
  }
  return changed ? out : null;
}

/** Cost is documented as 1 | 2 | 3; anything else is brought back into range. */
function clampCost(cost: number): 1 | 2 | 3 {
  if (!Number.isFinite(cost)) return 2;
  const rounded = Math.round(cost);
  if (rounded <= 1) return 1;
  if (rounded >= 3) return 3;
  return 2;
}