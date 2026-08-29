/**
 * PerfPolicy — single source of truth for inference timeouts, scaled by
 * target (local vs cloud) and overridable via env. The Rust host, the
 * sidecar, and the React frontend each carry an equivalent resolver so
 * the three layers agree on what "TTFT" and "total" mean.
 *
 * Defaults are deliberately generous: a legitimately slow-but-working
 * local model on weak hardware MUST NOT be killed mid-prefill. TTFT
 * scales with `promptTokens` (4 ms/token by default, capped at
 * `totalDeadlineMs`) so a 16k-token agent prompt gets a 154 s budget,
 * not a 90 s one — and the heartbeat proves liveness, so the watchdog
 * trips only on real stalls.
 *
 * Calibration knobs are env-overridable per the spec. None of these
 * values are user-visible in v1 (Settings UI is YAGNI per the spec's
 * Out-of-scope section); power users can still tune via env vars.
 *
 * Pure module — no I/O at import time beyond a one-shot env read.
 * The env read is also cached lazily on first call so test code that
 * mutates `process.env` between tests sees the new value.
 */

const DEFAULTS = {
  local: {
    ttftDeadlineMs: 90_000,
    totalDeadlineMs: 300_000,
    stallMs: 45_000,
  },
  // Raised from 30s/120s on 2026-08-29. The old pair was calibrated when
  // "cloud" meant a fast completion model and "local" meant a small GGUF on a
  // laptop — so cloud deadlines were deliberately the TIGHTER of the two. A
  // 2026 cloud reasoning model routinely thinks for minutes before its first
  // token, and the old floor cut it off mid-prefill with "Inference
  // unavailable", a message that names no cause the user can act on. The
  // relationship between the profiles is therefore inverted on purpose now:
  // cloud is the slow one.
  cloud: {
    ttftDeadlineMs: 300_000,
    totalDeadlineMs: 600_000,
    stallMs: 30_000,
  },
  /** Milliseconds added to prompt-token count for TTFT scaling. */
  perTokenPrefillMs: 4,
  /** Frontend-only: when to flip the "taking long" indicator. */
  softWarnMs: 20_000,
  /** Heartbeat cadence for stream-progress events. */
  heartbeatMs: 750,
} as const;

export interface PerfPolicy {
  /** Max wall-clock from request start to FIRST emitted token. */
  ttftDeadlineMs: number;
  /** Max wall-clock for the whole completion (first-token + all generation). */
  totalDeadlineMs: number;
  /** Max idle gap between consecutive tokens (per-token stall guard). */
  stallMs: number;
  /** Frontend-only: when to surface the "taking long" affordance row. */
  softWarnMs: number;
  /** Heartbeat cadence for stream-progress events. */
  heartbeatMs: number;
}

export interface ResolveArgs {
  isCloud: boolean;
  /**
   * Known prompt token count, when available. Used to scale TTFT so a
   * legitimately long prefill on a big prompt isn't killed. Pass
   * `undefined` (or omit) when unknown — the resolver falls back to the
   * unscaled base. The effective deadline is capped at `totalDeadlineMs`.
   */
  promptTokens?: number;
  /** Inject env for testing. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function readEnvNumber(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Resolve the perf policy for one request.
 *
 * Env precedence: any positive integer in the matching env var wins;
 * otherwise the target-specific default. The cloud `stallMs` keeps
 * reading `CINDERPAW_CLOUD_IDLE_TIMEOUT_MS` (back-compat — the existing
 * cloud-side timer was named that and we don't want to silently
 * re-scope it).
 */
export function resolvePerfPolicy(args: ResolveArgs): PerfPolicy {
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const base = args.isCloud ? DEFAULTS.cloud : DEFAULTS.local;

  const ttftDeadlineMs =
    readEnvNumber(env, "CINDERPAW_TTFT_DEADLINE_MS") ?? base.ttftDeadlineMs;
  const totalDeadlineMs =
    readEnvNumber(env, "CINDERPAW_TOTAL_DEADLINE_MS") ?? base.totalDeadlineMs;
  // `CINDERPAW_STALL_MS` is the new general stall setting (works for local AND
  // cloud). `CINDERPAW_CLOUD_IDLE_TIMEOUT_MS` is the legacy cloud-only back-compat
  // knob — when both are set we let the newer, more general one win so an
  // operator migrating doesn't see surprising flip-flops.
  const stallMs =
    readEnvNumber(env, "CINDERPAW_STALL_MS") ??
    (args.isCloud
      ? readEnvNumber(env, "CINDERPAW_CLOUD_IDLE_TIMEOUT_MS")
      : undefined) ??
    base.stallMs;

  let effectiveTtft = ttftDeadlineMs;
  if (args.promptTokens !== undefined && args.promptTokens > 0) {
    const scaled =
      ttftDeadlineMs + args.promptTokens * DEFAULTS.perTokenPrefillMs;
    effectiveTtft = Math.min(scaled, totalDeadlineMs);
  }

  return {
    ttftDeadlineMs: effectiveTtft,
    totalDeadlineMs,
    stallMs,
    softWarnMs: DEFAULTS.softWarnMs,
    heartbeatMs: DEFAULTS.heartbeatMs,
  };
}

/**
 * Stable machine-readable deadline reasons. Mirrors the Rust
 * `DeadlineReason` enum. Order matters: prefixes are matched
 * longest-first by `humanizeError.ts` so longer variants win if a
 * future reason ever overlaps a shorter one.
 */
export type DeadlineReason =
  | "ttft_timeout"
  | "total_timeout"
  | "stall_timeout"
  | "engine_unready";

/**
 * The human-readable line emitted via `cinderpaw://stream-error` (or its
 * sidecar equivalent) so the frontend can render the typed reason
 * verbatim. The `[bracketed-prefix]` is the machine token; everything
 * after it is the human copy.
 */
export function deadlineMessage(reason: DeadlineReason, policy: PerfPolicy): string {
  switch (reason) {
    case "ttft_timeout":
      return `[ttft_timeout] The model didn't start responding within ${Math.round(
        policy.ttftDeadlineMs / 1000,
      )}s. The prompt may be too long or the model too large for this hardware — try a shorter prompt, a smaller model, or a cloud key.`;
    case "total_timeout":
      return `[total_timeout] Generation ran past the ${Math.round(
        policy.totalDeadlineMs / 1000,
      )}s limit and was stopped. Try a smaller model or shorter output.`;
    case "stall_timeout":
      return `[stall_timeout] The model stopped producing output (no tokens for ${Math.round(
        policy.stallMs / 1000,
      )}s). It may have wedged — reloading is recommended.`;
    case "engine_unready":
      return `[engine_unready] The local model isn't loaded or stopped responding. Reload it and try again.`;
  }
}

/** Test-only: read the resolved defaults without env overrides. */
export const __TEST_DEFAULTS = DEFAULTS;