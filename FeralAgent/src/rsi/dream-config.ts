/**
 * Dream Cycle — scheduler configuration + cloud anti-burn gate.
 *
 * Where `episode-options.ts` describes *what a single bounded episode looks
 * like* (iteration cap, token cap, cost cap, concurrency), this file
 * describes *when the scheduler is allowed to launch one* and *whether the
 * current model endpoint is safe to dream against*.
 *
 * Two surfaces:
 *   1. `resolveDreamConfig(env)` — the trigger knobs (idle / cooldown /
 *      error threshold / poll interval / stop-on-activity). Defaults are
 *      sane for a local Ollama-class box where the dream runs on the same
 *      machine the user is typing on: a 3-minute idle gate, a 10-minute
 *      cooldown between episodes, three errors-in-window as the wake-up
 *      trigger, and a 30s poll. Operators tighten these via FERAL_RSI_*
 *      knobs; they cannot accidentally uncap the scheduler by leaving the
 *      env empty — invalid / negative / non-numeric values fall back to
 *      the default. Same `positive` / `nonNegative` discipline as
 *      `episode-options.ts` so the two configs feel like one family.
 *
 *   2. `dreamCloudGate(env, input)` — the cloud anti-burn safety net. Auto-
 *      dreaming is allowed by default ONLY when the active model endpoint
 *      is loopback (local). On a cloud (non-loopback) endpoint it is
 *      refused unless the operator explicitly sets FERAL_RSI_ALLOW_CLOUD.
 *      This sits ON TOP OF the existing FERAL_RSI_PASSIVE kill-switch and
 *      real-model check, which the caller (boot wiring) applies separately
 *      — we do NOT re-implement those here.
 *
 * The module is pure: no Date.now, no fs, no timers. Every output is a
 * function of the env object + an explicit input object — the same
 * determinism the rest of the rsi/ tree relies on for tests.
 */

export interface DreamConfig {
  /** Idle duration that triggers a dream cycle (ms). Default 3 minutes. */
  idleThresholdMs: number;
  /** Minimum gap between the end of one episode and the start of the next
   *  (ms). Default 10 minutes — prevents back-to-back thrashing. */
  cooldownMs: number;
  /** Error count (within `errorWindowMs`) that triggers a dream cycle.
   *  Clamped to >= 1: a threshold of 0 would mean "dream on every error",
   *  which is the thrashing behaviour this whole scheduler exists to
   *  prevent. Default 3. */
  errorThreshold: number;
  /** Rolling window in which `errorThreshold` counts errors (ms). Default
   *  15 minutes — long enough that a single bad request doesn't reset
   *  the counter, short enough that a quiet hour erases the slate. */
  errorWindowMs: number;
  /** How often the scheduler evaluates the idle / error triggers (ms).
   *  Default 30 seconds — fine enough that an idle dream starts within
   *  `idleThresholdMs + pollMs` of the user stepping away, coarse enough
   *  that the polling itself is invisible. */
  pollMs: number;
  /** When true, an in-flight dream is aborted the moment the user
   *  becomes active. Default false — dreams are cheap (local) and the
   *  cancellation churn isn't worth it; operators who want strict "user
   *  always wins" semantics flip this on. */
  stopOnActivity: boolean;
  /** Periodic "schedule" wake interval (ms) — the BRSI §2.8 schedule trigger.
   *  Undefined (the default: FERAL_RSI_SCHEDULE_MS unset/invalid) disables it,
   *  so idle/error stay the only automatic triggers and Faza-1 behaviour is
   *  unchanged. Set e.g. FERAL_RSI_SCHEDULE_MS=604800000 for a weekly wake. */
  scheduleIntervalMs?: number;
}

/** Input to the cloud anti-burn gate. The caller computes "is the active
 *  model endpoint loopback?" once and passes the answer here — the gate
 *  itself does no network probes (it must stay pure and cheap to call
 *  every poll). */
export interface DreamGateInput {
  /** True if the active model endpoint is loopback (local). */
  isLoopback: boolean;
}

/** The gate's verdict + a human-readable reason. The reason is what we
 *  log when the gate refuses, so operators can see *why* a dream did
 *  not start without having to re-derive the rules. */
export interface DreamGateDecision {
  enabled: boolean;
  reason: string;
}

/** Local env-parsing helpers — copied verbatim from `episode-options.ts`
 *  so the two files feel like siblings. `positive` accepts strictly
 *  positive finite numbers (0, negatives, NaN, Infinity, "" all fall
 *  back to the default). Every numeric knob in this file is time /
 *  count / interval — none of them accept 0 as a meaningful value, so
 *  the `nonNegative` variant from episode-options isn't needed.
 *
 *  `finite` is a sibling helper used ONLY by `errorThreshold`. It
 *  accepts any finite number, including 0 and negatives, because the
 *  min-1 clamp downstream is specifically designed to salvage those
 *  edge cases back to 1 instead of letting them fall back to the default
 *  (a "dream on every error" config is the thrashing behaviour this
 *  whole scheduler exists to prevent). */
const positive = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const finite = (v: string | undefined, dflt: number): number => {
  // Empty string and undefined → default. Otherwise accept any finite
  // number including 0 and negatives — the caller clamps as needed.
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/** Boolean parser for FERAL_RSI_* flags. Strict on purpose: only the
 *  literal strings "true" and "1" (case-insensitive, whitespace-trimmed)
 *  are truthy. Anything else — "yes", "on", "enabled", "True " — is
 *  false. Operators who want the gate open have to write it explicitly;
 *  a typo doesn't accidentally let a cloud dream run. */
const truthy = (v: string | undefined): boolean => {
  if (v === undefined) return false;
  const t = v.toLowerCase().trim();
  return t === "true" || t === "1";
};

/** Build the scheduler config from the sidecar's environment. Each
 *  numeric field reads its own FERAL_RSI_* knob and falls back to the
 *  default on anything that doesn't parse as a finite positive number
 *  (the `positive` parser refuses 0, negatives, NaN, Infinity, "" and
 *  non-numeric strings). `errorThreshold` uses the `finite` helper
 *  instead so 0 and negatives pass through to the `Math.max(1, ...)`
 *  clamp — a typo like FERAL_RSI_ERROR_THRESHOLD=0 must NOT re-introduce
 *  the "dream on every error" thrashing this scheduler replaces. */
export function resolveDreamConfig(
  env: Record<string, string | undefined>,
): DreamConfig {
  return {
    idleThresholdMs: positive(env.FERAL_RSI_IDLE_MS, 3 * 60_000),
    cooldownMs: positive(env.FERAL_RSI_COOLDOWN_MS, 10 * 60_000),
    errorThreshold: Math.max(
      1,
      Math.floor(finite(env.FERAL_RSI_ERROR_THRESHOLD, 3)),
    ),
    errorWindowMs: positive(env.FERAL_RSI_ERROR_WINDOW_MS, 15 * 60_000),
    pollMs: positive(env.FERAL_RSI_POLL_MS, 30_000),
    stopOnActivity: truthy(env.FERAL_RSI_STOP_ON_ACTIVITY),
    // 0/unset/invalid → undefined → schedule trigger disabled (Faza-1 default).
    scheduleIntervalMs: positive(env.FERAL_RSI_SCHEDULE_MS, 0) || undefined,
  };
}

/** The cloud anti-burn gate. Sits ON TOP OF the existing
 *  FERAL_RSI_PASSIVE kill-switch + real-model check, which the CALLER
 *  applies separately — we do NOT re-implement those here.
 *
 *  Rule:
 *    - Loopback (local) endpoint → dream allowed. Reasoning: the dream
 *      runs on the operator's own machine, costs nothing, and the worst
 *      case is a slow CPU during a user-imagined pause.
 *    - Cloud endpoint, FERAL_RSI_ALLOW_CLOUD explicitly truthy → dream
 *      allowed. The operator opted in by name; the message tells them
 *      exactly which knob did it.
 *    - Cloud endpoint, no opt-in → dream refused. The reason string
 *      names the knob so the next debugging session doesn't have to
 *      grep the source.
 *
 *  `positive` isn't used here — the gate reads a single boolean knob —
 *  but `truthy` shares the strict discipline of the rest of the config
 *  family. */
export function dreamCloudGate(
  env: Record<string, string | undefined>,
  input: DreamGateInput,
): DreamGateDecision {
  if (input.isLoopback) {
    return {
      enabled: true,
      reason: "local model (loopback) — dream allowed",
    };
  }
  if (truthy(env.FERAL_RSI_ALLOW_CLOUD)) {
    return {
      enabled: true,
      reason: "cloud model — explicitly opted in via FERAL_RSI_ALLOW_CLOUD",
    };
  }
  return {
    enabled: false,
    reason:
      "cloud model — auto-dream disabled (set FERAL_RSI_ALLOW_CLOUD=true to allow)",
  };
}
