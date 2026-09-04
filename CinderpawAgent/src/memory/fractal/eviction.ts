/**
 * Eviction policies — Pathway 4 PR-C Task C.1.
 *
 * Pure functions over the provenance-bearing `LeafSummary[]` exposed by
 * `FractalMemory.leaves()` (the C.0 durable store). A policy decides WHICH
 * leaf ids to drop; `FractalMemory.evict()` (C.2) applies the decision and
 * persists the removal. Keeping the policy pure makes it trivially testable
 * and lets the eviction cadence (on `rebalanceTreeIfNeeded`) be decided
 * elsewhere.
 */

import type { LeafSummary } from "./leaf-store.ts";
import { readEnv } from "../../config.ts";

export interface EvictionPolicy {
  /** Stable id, recorded in the evicted-leaf audit log. */
  readonly name: string;
  /** Return the ids of leaves to evict given the current set and `now`. */
  select(leaves: LeafSummary[], now: number): number[];
}

/** Opt-out / test policy: never evicts. The substrate grows unbounded. */
export class NoEviction implements EvictionPolicy {
  readonly name = "none";
  select(): number[] {
    return [];
  }
}

/**
 * Production default: evict a leaf only when it is BOTH stale and cold —
 * `now - last_seen_at > ageThresholdMs` AND `hit_count < hitCountThreshold`.
 * Strict comparisons on both bounds: a leaf exactly at the age threshold is
 * not yet old enough, and a leaf exactly at the hit-count threshold is not
 * cold enough. A frequently-recalled fact is never evicted regardless of age.
 */
export class AgeAndHitCountEviction implements EvictionPolicy {
  readonly name = "age_and_hit_count";
  constructor(
    private readonly ageThresholdMs: number,
    private readonly hitCountThreshold: number,
  ) {}

  select(leaves: LeafSummary[], now: number): number[] {
    const ids: number[] = [];
    for (const l of leaves) {
      const stale = now - l.last_seen_at > this.ageThresholdMs;
      const cold = l.hit_count < this.hitCountThreshold;
      if (stale && cold) ids.push(l.id);
    }
    return ids;
  }
}

/** 30 days, in ms — the default staleness window. */
export const DEFAULT_AGE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
/** Below this many hits a leaf is "cold". */
export const DEFAULT_HIT_COUNT_THRESHOLD = 2;

/** The values `CINDERPAW_FMS_EVICTION` actually understands. */
const NO_EVICTION_VALUES = new Set(["noeviction", "none", "off", "false"]);

/**
 * Pick the eviction policy from `CINDERPAW_FMS_EVICTION`.
 *
 * Unset is the production `AgeAndHitCountEviction` default. `"none"` (and its
 * obvious spellings) opts out. Anything else is a typo or a policy that does
 * not exist, and it SAYS SO: the documentation used to give `lru` as its
 * example, `lru` was never implemented, and an operator who set it got the
 * default policy with nothing anywhere to tell them their setting had no
 * effect. Falling back is still the behaviour — refusing to boot over one
 * env var would be worse — but it is now a fallback the operator is told
 * about instead of one they have to read the source to discover.
 */
export function selectPolicyFromEnv(log?: (msg: string) => void): EvictionPolicy {
  const raw = (readEnv("CINDERPAW_FMS_EVICTION") ?? "").trim().toLowerCase();
  if (raw === "") {
    return new AgeAndHitCountEviction(DEFAULT_AGE_THRESHOLD_MS, DEFAULT_HIT_COUNT_THRESHOLD);
  }
  if (NO_EVICTION_VALUES.has(raw)) return new NoEviction();
  const msg =
    `[cinderpaw] CINDERPAW_FMS_EVICTION="${raw}" is not a policy this build knows. ` +
    `Understood: "none" to turn eviction off, or leave it unset for the default ` +
    `age-and-hit-count policy. Using the default.`;
  (log ?? ((m: string) => console.warn(m)))(msg);
  return new AgeAndHitCountEviction(DEFAULT_AGE_THRESHOLD_MS, DEFAULT_HIT_COUNT_THRESHOLD);
}
