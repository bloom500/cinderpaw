/**
 * Episode options — the bounded run config the Dream Cycle scheduler hands
 * to the engine when it starts a single dream episode.
 *
 * The passive engine has an effectively-unbounded budget (continuous mode),
 * but a Dream Cycle episode is a short, scheduled burst: we want a hard
 * wall-clock cap, a finite iteration/token ceiling, and a tiny concurrency
 * floor so the dream doesn't fight the chat for resources. Defaults here
 * reflect that — operators can tighten them, but they can't accidentally
 * uncap a dream by leaving the env empty.
 *
 * The env-parsing discipline is copied verbatim from `passive-supervisor.ts`
 * (the same `positive` / `nonNegative` helpers, the same `1..4` clamp) so
 * the two configs feel like one config family. `STANDING_GOAL` is
 * re-exported unchanged so the dream reuses the same frozen objective the
 * passive engine is already optimising toward.
 */

import { STANDING_GOAL } from "./passive-supervisor.ts";
import { DEFAULT_BUDGET_CAPS, type BudgetCaps } from "./budget.ts";

export interface EpisodeOptions {
  goal: string;
  maxIterations: number;
  maxTotalTokens: number;
  /** USD spend cap for the episode. 0 = local-only (default). */
  maxTotalCostUsd: number;
  /** Compute cap: clamp to a sane 1..4. Default 1. */
  concurrency: number;
  /** Hard wall-clock cap for the episode, in milliseconds. Default 8*60_000. */
  maxWallClockMs: number;
  /** Stop early when fitness has not improved in this many iterations. Default 12. */
  plateauIterations: number;
}

/** Re-export the standing goal text unchanged — the dream optimises
 *  against the same frozen objective the passive engine already chases. */
export { STANDING_GOAL };

/** Lift the episode's bounded run config into the BRSI 6-resource budget
 *  model (§2.5) so the Evolution Journal can report honest remaining
 *  budget. The two resources the episode actually enforces (via GoalConfig
 *  stop conditions) become the caps: `tokens` from `maxTotalTokens`,
 *  `wallClockMin` from `maxWallClockMs`. The other four (cpu / ram / disk /
 *  energy) are not measured or enforced at the episode level yet, so they
 *  carry the §2.5 defaults as notional caps — a real resource monitor
 *  (Faza 4) fills them in. Pure; exported for testing. */
export function episodeBudgetCaps(opts: EpisodeOptions): BudgetCaps {
  return {
    ...DEFAULT_BUDGET_CAPS,
    tokens: opts.maxTotalTokens,
    wallClockMin: opts.maxWallClockMs / 60_000,
  };
}

/** Build the episode config from the sidecar's environment. Each numeric
 *  field reads its own FERAL_RSI_* knob and falls back to the default on
 *  anything that doesn't parse as a finite positive (or, for the cost
 *  cap, non-negative) number — same rules as `passiveStartOptions`. */
export function episodeStartOptions(
  env: Record<string, string | undefined>,
): EpisodeOptions {
  const positive = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const nonNegative = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    goal: STANDING_GOAL,
    maxIterations: positive(env.FERAL_RSI_MAX_ITER, 40),
    maxTotalTokens: positive(env.FERAL_RSI_MAX_TOKENS, 2_000_000),
    // 0 is the meaningful "local-only" sentinel — use nonNegative so an
    // operator can explicitly set $0 to forbid any cloud spend without
    // it falling back to the default.
    maxTotalCostUsd: nonNegative(env.FERAL_RSI_MAX_COST_USD, 0),
    // Concurrency cap. Default 1; clamp any override to a sane 1..4 so
    // a dream can't starve the chat by accident. Mirrors passiveStartOptions.
    concurrency: Math.max(1, Math.min(4, Math.floor(positive(env.FERAL_RSI_CONCURRENCY, 1)))),
    maxWallClockMs: positive(env.FERAL_RSI_EPISODE_MS, 8 * 60_000),
    plateauIterations: positive(env.FERAL_RSI_PLATEAU_ITERS, 12),
  };
}
