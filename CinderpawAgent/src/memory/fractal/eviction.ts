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

/**
 * Pick the eviction policy from `CINDERPAW_FMS_EVICTION`. `"NoEviction"` / `"none"`
 * opt out; anything else (including unset) is the production
 * `AgeAndHitCountEviction` default.
 */
export function selectPolicyFromEnv(): EvictionPolicy {
  const raw = (readEnv("CINDERPAW_FMS_EVICTION") ?? "").trim().toLowerCase();
  if (raw === "noeviction" || raw === "none") return new NoEviction();
  return new AgeAndHitCountEviction(DEFAULT_AGE_THRESHOLD_MS, DEFAULT_HIT_COUNT_THRESHOLD);
}
