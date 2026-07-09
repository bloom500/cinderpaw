/**
 * Faza 1 — runEval real: the eval-spec type and its deterministic
 * validator.
 *
 * One `EvalSpec` describes a single task the agent must perform: the
 * `prompt` to send, and the `kind`/`expected` pair that decides whether
 * the agent's response passes. This is the sidecar mirror of Rust's
 * `tier0::Tier0Spec` + `validate_outcome`, extended with the `prompt`
 * field (which Tier 0 left implicit) and a `tier` discriminator so the
 * same machinery loads Tier 0 (from Rust) and Tier 1/2 (from disk).
 *
 * The four `kind`s here are exactly the four Rust freezes for Tier 0, so
 * a Tier 0 spec fetched over the bridge validates identically on both
 * sides. Tier 1/2 behavioural kinds (keyword sets, refusal) are added
 * alongside these as the suites grow; each new kind must stay
 * deterministic so an eval run is reproducible for PBT.
 */

/** The validator family. Mirrors Rust `tier0::Tier0Kind` (snake_case). */
export type EvalKind =
  | "json_format"
  | "fact_lookup"
  | "token_budget"
  | "latency";

/** Per-kind expected payload. Tagged union mirroring Rust's
 *  `Tier0Expected` (`#[serde(tag = "type", rename_all = "snake_case")]`). */
export type EvalExpected =
  | { type: "json_format"; required_keys: string[] }
  | { type: "fact_lookup"; answer: string }
  | { type: "token_budget"; max_tokens: number }
  | { type: "latency"; max_ms: number };

/** One eval task. `tier` is 0 | 1 | 2. */
export interface EvalSpec {
  id: string;
  tier: number;
  name: string;
  description: string;
  /** The prompt sent to the agent for this task. */
  prompt: string;
  kind: EvalKind;
  expected: EvalExpected;
  /** Capability domain for `capabilitiesMeasured` aggregation (L4 spec §5).
   *  Brain Stack vocabulary (`capability-registry.ts` `Capability`).
   *  Optional: specs without one fall back to a deterministic kind→domain
   *  map in `module-eval.ts`. */
  domain?: string;
}

/**
 * Decide whether a single agent response passes its spec. Deterministic
 * pass/fail only — never a score. Returns `false` on any kind/expected
 * mismatch, defending against malformed specs on disk exactly as Rust's
 * exhaustiveness `_ => false` branch does.
 */
export function validateOutcome(
  spec: EvalSpec,
  response: string,
  tokens: number,
  latencyMs: number,
): boolean {
  const { kind, expected } = spec;
  if (kind === "json_format" && expected.type === "json_format") {
    return jsonFormatOk(response, expected.required_keys);
  }
  if (kind === "fact_lookup" && expected.type === "fact_lookup") {
    return factLookupOk(response, expected.answer);
  }
  if (kind === "token_budget" && expected.type === "token_budget") {
    return tokens <= expected.max_tokens;
  }
  if (kind === "latency" && expected.type === "latency") {
    return latencyMs <= expected.max_ms;
  }
  return false;
}

function jsonFormatOk(response: string, requiredKeys: string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  return requiredKeys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function factLookupOk(response: string, answer: string): boolean {
  const r = normalise(response);
  const a = normalise(answer);
  if (r.length === 0 || a.length === 0) return false;
  return r.includes(a);
}

/** Collapse whitespace and lowercase — matches Rust's `normalise`. */
function normalise(s: string): string {
  return s.trim().split(/\s+/).join(" ").toLowerCase();
}
