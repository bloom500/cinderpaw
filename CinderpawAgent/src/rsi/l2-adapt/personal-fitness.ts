/**
 * Personal Fitness — the per-user signal that fills the
 * `userSatisfaction` component of the BRSI fitness vector (BRSI §2.10).
 *
 * Why this exists:
 *   The other five fitness-vector components (Accuracy / Latency /
 *   Cost / ToolSuccess / Hallucination) come from the Rust scorer and
 *   its eval-suite. The sixth — UserSatisfaction — has to come from
 *   THIS user's interaction history. Sakana-style global-capability
 *   optimisation ignores this dimension; Cinderpaw explicitly does not.
 *
 *   The aggregator here is deliberately pluggable. The signal kinds
 *   listed in BRSI §2.10 (acceptance / tool-call / workflow /
 *   memory-reuse / preference / edit-after-accept) arrive at
 *   different times and from different sources; some don't exist in
 *   the engine today. The aggregator consumes a uniform `UserSignal`
 *   shape so adding a new source is an adapter, not a rewrite.
 *
 * Discipline: pure logic. The caller injects signals (or a reader
 * that produces them) — this module never touches the audit log
 * table directly. Tests pass synthetic signals; the production wiring
 * reads from `AuditLog` (see `src/sandbox/audit-log.ts`) via an
 * adapter.
 */

/** A single user-facing signal. Each kind has a default weight
 *  (positive = good, negative = bad). The value is +1/-1 in the
 *  common case but the schema allows [-1, 1] continuous values for
 *  signals like preference alignment that come in shades. */
export interface UserSignal {
  /** When the signal happened (ms since epoch). */
  timestamp: number;
  /** Signed contribution in [-1, 1]. +1 = good, -1 = bad. */
  value: number;
  /** Which kind of signal this is. */
  kind: UserSignalKind;
  /** Optional context for debugging (e.g., tool name, session id). */
  context?: string;
}

/** The signal kinds we know about. BRSI §2.10 lists six; the tool-call,
 *  memory-reuse, and acceptance (thumbs) kinds have wired sources.
 *  The remaining three are TODO with documented gaps. */
export type UserSignalKind =
  | "tool_success"        // Tool-call audit, result="success" (sources: tools/registry.ts:501)
  | "tool_error"          // Tool-call audit, result="error"   (sources: tools/registry.ts:539)
  | "memory_reuse"        // recall.ts hit (positive) vs miss (negative) — TODO wire
  | "acceptance"          // Thumbs 👍/👎 on an agent message (audit "feedback" rows)
  | "edit_after_accept"   // User edited agent output          — TODO wire (no source today)
  | "workflow_completion" // UIA demo replay success           — TODO wire (Layer 2+ work)
  | "preference_match";   // Settings vs response style        — TODO wire

/** Default weights per kind. WEIGHTS ARE MAGNITUDES (always positive).
 *  The sign of a signal's contribution comes from its `value` field:
 *    value=+1, kind="tool_success"     → +0.20 (good)
 *    value=-1, kind="tool_error"       → -0.30 (bad, value is negative)
 *    value=-1, kind="edit_after_accept" → -0.50 (bad)
 *  `totalAbsWeight = Σ |w|` is the normalisation denominator so the
 *  aggregate is in [-1, 1] before mapping to [0, 1]. Tunable via
 *  SandboxBounds (locked D4 = ship defaults, learn from Journal after
 *  30 cycles). */
export const DEFAULT_USER_SIGNAL_WEIGHTS: Record<UserSignalKind, number> = {
  tool_success: 0.20,
  tool_error: 0.30,
  memory_reuse: 0.25,
  acceptance: 0.40,
  edit_after_accept: 0.50,
  workflow_completion: 0.35,
  preference_match: 0.15,
};

/** Inputs to the aggregator. */
export interface PersonalFitnessInput {
  signals: UserSignal[];
  /** Window size in ms — signals older than `now - windowMs` are
   *  dropped. Default 7 days (matches weekly default dream trigger). */
  windowMs?: number;
  /** Optional weight overrides per kind (defaults to DEFAULT_USER_SIGNAL_WEIGHTS). */
  weights?: Partial<Record<UserSignalKind, number>>;
  /** "Now" for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
}

/** Compute userSatisfaction ∈ [0, 1]. The signal-weighted sum is
 *  normalised by the total |weight| of signals that fell inside the
 *  window, giving a value in [-1, 1]. We then map to [0, 1] via
 *  `(x + 1) / 2`. A result of 0.5 means "no signal" / "neutral";
 *  1.0 means everything was positive; 0.0 means everything was negative.
 *
 *  When the rolling window contains zero signals, returns 0.5 (the
 *  neutral default — same shape `scoreToFitnessVector` uses for
 *  unmeasured components in `fitness.ts`). */
export function computePersonalFitness(input: PersonalFitnessInput): number {
  const weights: Record<UserSignalKind, number> = {
    ...DEFAULT_USER_SIGNAL_WEIGHTS,
    ...(input.weights ?? {}),
  };
  const windowMs = input.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = input.now ?? Date.now();

  let weightedSum = 0;
  let totalAbsWeight = 0;

  for (const sig of input.signals) {
    if (now - sig.timestamp > windowMs) continue;
    const w = weights[sig.kind];
    const v = clampSigned(sig.value);
    weightedSum += w * v;
    totalAbsWeight += Math.abs(w);
  }

  if (totalAbsWeight === 0) return 0.5;

  // Normalise to [-1, 1] then map to [0, 1].
  const normalised = weightedSum / totalAbsWeight;
  return clamp01((normalised + 1) / 2);
}

/** Adapter: turn audit-log entries into UserSignals.
 *  Reads `tool_call` rows (tool success/error) and `feedback` rows (the
 *  user's thumbs 👍/👎 → the `acceptance` signal). Memory writes
 *  (`actionType === "memory_write"`) are agent-internal — they're NOT a
 *  user signal and are NOT surfaced here. */
export function auditEntriesToUserSignals(
  entries: ReadonlyArray<AuditEntryLike>,
): UserSignal[] {
  const out: UserSignal[] = [];
  for (const e of entries) {
    if (e.actionType === "feedback") {
      // 👍 recorded as result "success", 👎 as "error".
      const up = e.result === "success";
      out.push({
        timestamp: e.timestamp,
        value: up ? 1 : -1,
        kind: "acceptance",
        context: e.toolName,
      });
      continue;
    }
    if (e.actionType !== "tool_call") continue;
    const ok = e.result === "success";
    out.push({
      timestamp: e.timestamp,
      value: ok ? 1 : -1,
      kind: ok ? "tool_success" : "tool_error",
      context: e.toolName,
    });
  }
  return out;
}

/** Adapter: turn recall hit/miss counts into UserSignals.
 *  `hits` = positive, `misses` = negative. Each hit/miss is one
 *  signal so the weighted sum scales with usage. */
export function recallCountsToUserSignals(
  args: { timestamp: number; hits: number; misses: number },
): UserSignal[] {
  const out: UserSignal[] = [];
  for (let i = 0; i < args.hits; i++) {
    out.push({ timestamp: args.timestamp, value: 1, kind: "memory_reuse" });
  }
  for (let i = 0; i < args.misses; i++) {
    out.push({ timestamp: args.timestamp, value: -1, kind: "memory_reuse" });
  }
  return out;
}

/** Minimal shape of an audit-log row. Matches the `AuditEntry` from
 *  `src/sandbox/audit-log.ts`; defined locally so this module has no
 *  hard import into the sandbox layer. */
export interface AuditEntryLike {
  timestamp: number;
  actionType: string;
  toolName?: string;
  result?: string;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function clampSigned(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < -1) return -1;
  if (x > 1) return 1;
  return x;
}