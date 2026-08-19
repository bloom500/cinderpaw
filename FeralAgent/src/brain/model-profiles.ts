/**
 * Model profiles — Phase 1 (Brain Autonomy).
 *
 * Turns a real `ModelTarget` into the `capabilities` / `cost` / `local`
 * fields a `BrainModel` needs, so Brain Stack can be built WITHOUT a
 * hand-written `~/.feral/brain.json`. Before this module, capability
 * numbers existed only where a human typed them, which is why Brain was
 * off on every installation that ever shipped
 * (see docs/ui/2026-08-19-brain-current-state.md §6).
 *
 * This is a lookup table, not a scoring system. It deliberately does NOT
 * introduce a second capability model: the vocabulary, the 0..10 range and
 * the 1|2|3 cost ordinal are exactly the ones `capability-registry.ts`
 * already defines.
 *
 * Evidence ladder (only the first rung exists today):
 *   1. declared  — this table, keyed by model family                  ← here
 *   2. benchmark — external scores, later
 *   3. observed  — runtime success/latency per model id, later. The
 *      circuit breaker already keys on `BrainModel.id`, so observation
 *      has a home; it is not a new subsystem.
 *
 * ponytail: a table, not a registry service. If it ever needs to be
 * user-editable, `brain.json` already overrides everything here.
 */

import type { ModelTarget } from "../types.ts";
import type { Capability } from "./capability-registry.ts";
import { normalizeCapabilities } from "./capability-registry.ts";

/** The `BrainModel` fields this module derives (everything except id + target). */
export interface ModelProfile {
  capabilities: Record<Capability, number>;
  cost: 1 | 2 | 3;
  local: boolean;
}

/**
 * Conservative profile for a model nobody has scored.
 *
 * Mid on everything the scorer can verify cheaply, and NOT optimistic:
 * an unproven model that claims to be great is how a routing table starts
 * lying. The failure this biases toward is "Feral used the other model",
 * which is recoverable. The failure it avoids is "Feral picked the unknown
 * model for the hardest task and produced nothing", which is not.
 *
 * `vision: 0` because vision is a hard capability, not a soft one — a model
 * that cannot see images does not "see them badly". Guessing 5 here would
 * let an unknown text model win a `vision` route and fail every time.
 */
const UNKNOWN_CAPS: Record<Capability, number> = {
  reasoning: 5,
  coding: 5,
  vision: 0,
  speed: 5,
  multilingual: 5,
};

/**
 * Known model families, matched against a lowercased `target.model`.
 *
 * Order matters — the first matching pattern wins, so more specific
 * patterns come first ("qwen2.5-coder" before "qwen"). Values are
 * hand-assigned, deliberately coarse, and only ever compared against each
 * other: the scorer multiplies them by a requirement weight, so what
 * matters is the ORDERING between families, not the absolute number.
 */
const FAMILIES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly caps: Partial<Record<Capability, number>>;
  readonly cost: 1 | 2 | 3;
}> = [
  // ── Cloud, premium ───────────────────────────────────────────────────
  {
    pattern: /\b(claude|anthropic)\b|claude-/,
    caps: { reasoning: 9, coding: 9, vision: 8, speed: 6, multilingual: 8 },
    cost: 3,
  },
  {
    pattern: /\bgpt-?[45]|\bo[134]\b|\bgpt\b/,
    caps: { reasoning: 9, coding: 8, vision: 8, speed: 6, multilingual: 8 },
    cost: 3,
  },
  {
    pattern: /\bgemini\b/,
    caps: { reasoning: 8, coding: 8, vision: 9, speed: 7, multilingual: 9 },
    cost: 2,
  },
  // ── Local / open-weight families ─────────────────────────────────────
  // Coder variants are strong at code and weak at everything else; they
  // must be matched before their base family.
  {
    pattern: /qwen.*coder|coder.*qwen/,
    caps: { reasoning: 6, coding: 8, vision: 0, speed: 7, multilingual: 5 },
    cost: 1,
  },
  {
    pattern: /\bqwen/,
    // Qwen is the strongest open family on non-English text by a wide
    // margin, which matters for a product shipped in Romanian.
    caps: { reasoning: 6, coding: 6, vision: 0, speed: 7, multilingual: 8 },
    cost: 1,
  },
  {
    pattern: /deepseek.*coder|deepseek-?v?[23]/,
    caps: { reasoning: 7, coding: 8, vision: 0, speed: 5, multilingual: 5 },
    cost: 1,
  },
  {
    pattern: /\bdeepseek/,
    caps: { reasoning: 7, coding: 7, vision: 0, speed: 5, multilingual: 5 },
    cost: 1,
  },
  {
    pattern: /\bllama|\bllava/,
    caps: { reasoning: 6, coding: 5, vision: 0, speed: 6, multilingual: 5 },
    cost: 1,
  },
  {
    pattern: /\bmistral|\bmixtral|\bmagistral/,
    caps: { reasoning: 6, coding: 6, vision: 0, speed: 7, multilingual: 6 },
    cost: 1,
  },
  {
    pattern: /\bgemma/,
    caps: { reasoning: 5, coding: 5, vision: 0, speed: 8, multilingual: 6 },
    cost: 1,
  },
  {
    pattern: /\bphi-?[34]?/,
    // Small and fast; the speed score is the whole point of picking it.
    caps: { reasoning: 5, coding: 5, vision: 0, speed: 9, multilingual: 3 },
    cost: 1,
  },
];

/**
 * Model names that advertise vision regardless of family. Checked as an
 * override because vision is the one capability where a wrong guess is a
 * guaranteed failure rather than a worse answer.
 */
const VISION_MARKERS = /\bvl\b|-vl-|vision|llava|\bvlm\b/;

/**
 * Mirrors `InferenceRouter.#isLocalHost` (egress/inference-router.ts:360).
 *
 * Duplicated rather than exported from the router: this module must stay a
 * pure function of a `ModelTarget` with no dependency on a live router
 * instance, and the rule (loopback host) is three literals, not logic worth
 * sharing. If it ever grows, promote it to a shared helper and use it in
 * both places.
 */
export function isLocalTarget(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * Derive the capability profile for a target.
 *
 * `local` comes from the base URL, never from the model name — a Qwen
 * served by a cloud provider is not a local model, and a proxy in front of
 * Claude on loopback is.
 */
export function profileFor(target: ModelTarget): ModelProfile {
  const name = (target.model ?? "").toLowerCase();
  const local = isLocalTarget(target.baseUrl ?? "");

  const family = FAMILIES.find((f) => f.pattern.test(name));
  const caps = normalizeCapabilities(family ? family.caps : UNKNOWN_CAPS);

  if (VISION_MARKERS.test(name)) caps.vision = Math.max(caps.vision, 7);

  // A local target is cheap by definition — it costs electricity, not
  // dollars — even when the family table was written for its cloud twin.
  const cost: 1 | 2 | 3 = local ? 1 : (family?.cost ?? 2);

  return { capabilities: caps, cost, local };
}

/** True when the family table recognises this model name. Exposed for tests. */
export function isKnownFamily(model: string): boolean {
  return FAMILIES.some((f) => f.pattern.test(model.toLowerCase()));
}
