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

/** The validator family. The first four mirror Rust `tier0::Tier0Kind`
 *  (snake_case); `tool_call` is a TS-side Tier 1/2 kind — it grades the
 *  agent's ability to pick the right tool and shape a correct call, the
 *  capability the trivia kinds never touched. Deterministic like every
 *  other kind (a hard requirement for PBT reproducibility). */
export type EvalKind =
  | "json_format"
  | "fact_lookup"
  | "token_budget"
  | "latency"
  | "tool_call";

/** Per-kind expected payload. Tagged union mirroring Rust's
 *  `Tier0Expected` (`#[serde(tag = "type", rename_all = "snake_case")]`). */
export type EvalExpected =
  | { type: "json_format"; required_keys: string[] }
  | { type: "fact_lookup"; answer: string }
  | { type: "token_budget"; max_tokens: number }
  | { type: "latency"; max_ms: number }
  | {
      type: "tool_call";
      /** The tool the agent must choose. */
      tool: string;
      /** Argument keys that must be present in the emitted call. */
      required_args: string[];
      /** Optional exact-value pins: each key must equal this value
       *  (after String() normalisation, case-insensitive). */
      arg_equals?: Record<string, string>;
    };

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
  if (kind === "tool_call" && expected.type === "tool_call") {
    return toolCallOk(response, expected);
  }
  return false;
}

/** Validate a tool_call response: the agent must emit a JSON object
 *  `{"tool": "<name>", "args": {...}}` (bare or inside a ```json fence).
 *  Pass iff the tool matches, every required arg key is present, and any
 *  pinned values match (string-normalised, case-insensitive). */
function toolCallOk(
  response: string,
  expected: Extract<EvalExpected, { type: "tool_call" }>,
): boolean {
  const body = extractJsonObject(response);
  if (!body) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const call = parsed as { tool?: unknown; args?: unknown };
  if (typeof call.tool !== "string" || call.tool.trim() !== expected.tool) return false;
  const args =
    call.args && typeof call.args === "object" && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : {};
  for (const key of expected.required_args) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) return false;
  }
  for (const [key, want] of Object.entries(expected.arg_equals ?? {})) {
    const got = args[key];
    if (got === undefined) return false;
    if (String(got).trim().toLowerCase() !== want.trim().toLowerCase()) return false;
  }
  return true;
}

/** First JSON object in the response: a fenced ```json block wins, else
 *  the substring from the first `{` to the LAST `}` (tolerates prose
 *  before/after but not interleaved). */
function extractJsonObject(response: string): string | null {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(response);
  const src = fence?.[1] ?? response;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return src.slice(start, end + 1);
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

/**
 * Collapse whitespace, fold compatibility forms, lowercase.
 *
 * `NFKC` is the whole reason this is not a one-liner, and it is doing real
 * work: asked for the chemical formula of water, the model answers **`H₂O`**
 * with a Unicode subscript, while the frozen spec expects `h2o`. A correct
 * answer was being graded wrong — and because that spec is Tier 0, one
 * typographic flourish breached the sanity floor and blocked every promotion.
 *
 * NFKC is the standard answer to exactly this class: it maps subscripts and
 * superscripts to their ASCII digits, fullwidth Latin to ASCII, ligatures to
 * their letters. It cannot turn a wrong answer into a right one — it only
 * removes the ways of writing the SAME answer differently.
 *
 * Rust's `normalise` (tier0.rs) does not fold, so a Tier 0 spec graded on that
 * side is still literal. This is the side that grades the live eval suite.
 */
function normalise(s: string): string {
  return s.normalize("NFKC").trim().split(/\s+/).join(" ").toLowerCase();
}
