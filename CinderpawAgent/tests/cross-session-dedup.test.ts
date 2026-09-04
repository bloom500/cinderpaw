import { describe, it, expect } from "bun:test";
import { dedupAcrossSessions, type DedupLeaf } from "../src/memory/fractal/cross-session-dedup.ts";

const DAY = 86_400_000;

function makeLeaf(overrides: Partial<DedupLeaf> & { id: number; vec: number[] }): DedupLeaf {
  const now = Date.now();
  return {
    text: `leaf-${overrides.id}`,
    first_seen_at: now - 60 * DAY,
    last_seen_at: now - 10 * DAY,
    hit_count: 1,
    ...overrides,
  };
}

describe("dedupAcrossSessions", () => {
  it("collapses leaves that are similar and span >= threshold", () => {
    const now = 100_000_000;
    const leaves: DedupLeaf[] = [
      makeLeaf({ id: 1, first_seen_at: now - 60 * DAY, last_seen_at: now - 50 * DAY, hit_count: 5, vec: [1, 0, 0] }),
      makeLeaf({ id: 2, first_seen_at: now - 10 * DAY, last_seen_at: now, hit_count: 3, vec: [0.99, 0.01, 0] }),
    ];
    const groups = dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * DAY, now });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.survivor.id).toBe(1);
    expect(groups[0]!.absorbed.map((l) => l.id)).toEqual([2]);
    expect(groups[0]!.survivor.last_seen_at).toBe(now);
    expect(groups[0]!.survivor.hit_count).toBe(8);
  });

  it("does NOT collapse leaves within span threshold", () => {
    const now = 100_000_000;
    const leaves: DedupLeaf[] = [
      makeLeaf({ id: 1, first_seen_at: now - 5 * DAY, vec: [1, 0, 0] }),
      makeLeaf({ id: 2, first_seen_at: now - 1 * DAY, vec: [0.99, 0.01, 0] }),
    ];
    const groups = dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * DAY, now });
    expect(groups).toEqual([]);
  });

  it("does NOT collapse leaves that are not cosine-similar", () => {
    const now = 100_000_000;
    const leaves: DedupLeaf[] = [
      makeLeaf({ id: 1, first_seen_at: now - 60 * DAY, vec: [1, 0, 0] }),
      makeLeaf({ id: 2, first_seen_at: now - 10 * DAY, vec: [0, 1, 0] }),
    ];
    const groups = dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * DAY, now });
    expect(groups).toEqual([]);
  });

  it("groups of 3+ collapse correctly", () => {
    const now = 100_000_000;
    const leaves: DedupLeaf[] = [
      makeLeaf({ id: 1, first_seen_at: now - 90 * DAY, last_seen_at: now - 80 * DAY, hit_count: 2, vec: [1, 0, 0] }),
      makeLeaf({ id: 2, first_seen_at: now - 50 * DAY, last_seen_at: now - 40 * DAY, hit_count: 3, vec: [0.98, 0.02, 0] }),
      makeLeaf({ id: 3, first_seen_at: now - 10 * DAY, last_seen_at: now, hit_count: 1, vec: [0.97, 0.03, 0] }),
    ];
    const groups = dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * DAY, now });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.survivor.id).toBe(1);
    expect(groups[0]!.absorbed.map((l) => l.id).sort()).toEqual([2, 3]);
    expect(groups[0]!.survivor.last_seen_at).toBe(now);
    expect(groups[0]!.survivor.hit_count).toBe(6);
  });

  it("returns empty for empty input", () => {
    const groups = dedupAcrossSessions([], { mergeThreshold: 0.92, spanThresholdMs: 30 * DAY, now: Date.now() });
    expect(groups).toEqual([]);
  });

  it("does not group unrelated leaves into the same group", () => {
    const now = 100_000_000;
    const leaves: DedupLeaf[] = [
      makeLeaf({ id: 1, first_seen_at: now - 60 * DAY, vec: [1, 0, 0] }),
      makeLeaf({ id: 2, first_seen_at: now - 50 * DAY, vec: [0, 1, 0] }),
      makeLeaf({ id: 3, first_seen_at: now - 40 * DAY, vec: [0, 0, 1] }),
    ];
    const groups = dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * DAY, now });
    expect(groups).toEqual([]);
  });
});
