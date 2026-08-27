/**
 * EvictionPolicy — Pathway 4 PR-C Task C.1.
 *
 * Pure policies over `(leaves, now) → leafIdsToEvict`, where `leaves` are the
 * provenance-bearing `LeafSummary[]` from `FractalMemory.leaves()` (the C.0
 * durable store). Two impls: `NoEviction` (test/opt-out) and
 * `AgeAndHitCountEviction` (production default). `selectPolicyFromEnv()` picks
 * via `CINDERPAW_FMS_EVICTION`.
 *
 * Boundaries pinned explicitly: age uses strict `>` (exactly at threshold is
 * NOT old enough), hit-count uses strict `<` (exactly at threshold is NOT low).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  NoEviction,
  AgeAndHitCountEviction,
  selectPolicyFromEnv,
} from "../src/memory/fractal/eviction.ts";
import type { LeafSummary } from "../src/memory/fractal/leaf-store.ts";

function leaf(over: Partial<LeafSummary> & { id: number }): LeafSummary {
  return {
    text: `fact ${over.id}`,
    first_seen_at: 0,
    last_seen_at: 0,
    hit_count: 0,
    ...over,
  };
}

afterEach(() => { delete process.env.CINDERPAW_FMS_EVICTION; });

describe("EvictionPolicy", () => {
  test("NoEviction never selects leaves", () => {
    const policy = new NoEviction();
    const leaves = [leaf({ id: 1, last_seen_at: 0, hit_count: 0 })];
    expect(policy.select(leaves, Date.now())).toEqual([]);
    expect(policy.name).toBe("none");
  });

  test("AgeAndHitCountEviction evicts old + low-hit leaves only", () => {
    const now = 100_000_000;
    const policy = new AgeAndHitCountEviction(1000, 2);
    const leaves = [
      leaf({ id: 1, last_seen_at: now - 5000, hit_count: 0 }),  // old + low  → evict
      leaf({ id: 2, last_seen_at: now - 5000, hit_count: 10 }), // old + high → keep
      leaf({ id: 3, last_seen_at: now - 100, hit_count: 0 }),   // fresh + low → keep
    ];
    expect(policy.select(leaves, now).sort()).toEqual([1]);
    expect(policy.name).toBe("age_and_hit_count");
  });

  test("boundary: exactly at age threshold is NOT old enough", () => {
    const now = 100_000_000;
    const policy = new AgeAndHitCountEviction(1000, 2);
    const leaves = [leaf({ id: 1, last_seen_at: now - 1000, hit_count: 0 })]; // age == threshold
    expect(policy.select(leaves, now)).toEqual([]); // not > threshold
  });

  test("boundary: exactly at hit-count threshold is NOT low", () => {
    const now = 100_000_000;
    const policy = new AgeAndHitCountEviction(1000, 2);
    const leaves = [leaf({ id: 1, last_seen_at: now - 5000, hit_count: 2 })]; // hit == threshold
    expect(policy.select(leaves, now)).toEqual([]); // not < threshold
  });

  test("respects env override CINDERPAW_FMS_EVICTION=NoEviction", () => {
    process.env.CINDERPAW_FMS_EVICTION = "NoEviction";
    expect(selectPolicyFromEnv()).toBeInstanceOf(NoEviction);
  });

  test("default policy (env unset) is AgeAndHitCountEviction", () => {
    delete process.env.CINDERPAW_FMS_EVICTION;
    expect(selectPolicyFromEnv()).toBeInstanceOf(AgeAndHitCountEviction);
  });
});
