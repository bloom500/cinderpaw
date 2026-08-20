/**
 * PerfPolicy — frontend mirror of `CinderpawAgent/src/sandbox/perf-policy.ts`
 * and `src-tauri/src/inference.rs::perf_policy`. All three layers agree on
 * the same shape so the watchdog, deadline controller, and UI never
 * disagree on what "TTFT" or "total" mean.
 *
 * Defaults match the sidecar exactly. In v1 the Settings UI for these is
 * YAGNI (spec §"Out of scope"); the resolver still reads env for power
 * users and is `settings`-store-aware so the Settings UI can be added in
 * a follow-up slice without an API change.
 *
 * Pure module — no React, no zustand imports, so it's trivially unit-testable.
 */

export type DeadlineReason =
  | 'ttft_timeout'
  | 'total_timeout'
  | 'stall_timeout'
  | 'engine_unready';

export interface PerfPolicy {
  ttftDeadlineMs: number;
  totalDeadlineMs: number;
  stallMs: number;
  softWarnMs: number;
  heartbeatMs: number;
}

export interface ResolveArgs {
  isCloud: boolean;
  /** Known prompt token count, when available. */
  promptTokens?: number;
  /** Inject env for testing. Defaults to `import.meta.env` where available. */
  env?: Record<string, string | undefined>;
}

const DEFAULTS = {
  local:   { ttftDeadlineMs: 90_000,  totalDeadlineMs: 300_000, stallMs: 45_000 },
  cloud:   { ttftDeadlineMs: 30_000,  totalDeadlineMs: 120_000, stallMs: 30_000 },
  perTokenPrefillMs: 4,
  softWarnMs:  20_000,
  heartbeatMs: 750,
} as const;

function readEnvNumber(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Resolve the perf policy for one request.
 *
 * Vite exposes `import.meta.env` as a plain object, so callers in tests
 * can pass a fake env. In production the resolver reads from
 * `import.meta.env` — non-Vite env (Node tests) falls back to `process.env`.
 */
export function resolvePerfPolicy(args: ResolveArgs): PerfPolicy {
  const env = args.env ?? readFrontendEnv();
  const base = args.isCloud ? DEFAULTS.cloud : DEFAULTS.local;

  const ttftDeadlineMs = readEnvNumber(env, 'FERAL_TTFT_DEADLINE_MS') ?? base.ttftDeadlineMs;
  const totalDeadlineMs = readEnvNumber(env, 'FERAL_TOTAL_DEADLINE_MS') ?? base.totalDeadlineMs;
  const stallMs =
    readEnvNumber(env, 'FERAL_STALL_MS') ??
    (args.isCloud ? readEnvNumber(env, 'FERAL_CLOUD_IDLE_TIMEOUT_MS') : undefined) ??
    base.stallMs;

  let effectiveTtft = ttftDeadlineMs;
  if (args.promptTokens !== undefined && args.promptTokens > 0) {
    const scaled = ttftDeadlineMs + args.promptTokens * DEFAULTS.perTokenPrefillMs;
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
 * Vite exposes only `VITE_*` env vars to the client by default. We use a
 * plain `import.meta.env` lookup so production builds with explicit
 * `define` overrides work; in vitest under jsdom, `import.meta.env` is
 * defined and tests inject via the `env` arg above.
 */
function readFrontendEnv(): Record<string, string | undefined> {
  // Both paths are populated by Vite when present; in Node tests neither
  // is and we just return an empty object so `resolvePerfPolicy` falls
  // back to its hard-coded defaults.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (import.meta as any)?.env ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (globalThis as any)?.process?.env ?? {};
    return { ...proc, ...meta };
  } catch {
    return {};
  }
}

/** Human-readable copy for each typed deadline reason. */
export function deadlineMessage(reason: DeadlineReason, policy: PerfPolicy): string {
  switch (reason) {
    case 'ttft_timeout':
      return `[ttft_timeout] The model didn't start responding within ${Math.round(policy.ttftDeadlineMs / 1000)}s. The prompt may be too long or the model too large for this hardware. Try a shorter prompt, a smaller model, or a cloud key.`;
    case 'total_timeout':
      return `[total_timeout] Generation ran past the ${Math.round(policy.totalDeadlineMs / 1000)}s limit and was stopped. Try a smaller model or shorter output.`;
    case 'stall_timeout':
      return `[stall_timeout] The model stopped producing output (no tokens for ${Math.round(policy.stallMs / 1000)}s). It may have wedged, and reloading is recommended.`;
    case 'engine_unready':
      return `[engine_unready] The local model isn't loaded or stopped responding. Reload it and try again.`;
  }
}

/** Test-only: read the resolved defaults without env overrides. */
export const __TEST_DEFAULTS = DEFAULTS;