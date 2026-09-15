import { describe, expect, it } from "bun:test";
import { armIds, memoryBlock, pairedDiff } from "../../scripts/memory-order-headroom.ts";

describe("memory-order headroom arms", () => {
  const ranked = Array.from({ length: 40 }, (_, i) => i + 1);
  it("FMS is the top 10, REVERSED the same set backwards, NONE is empty", () => {
    expect(armIds("FMS", ranked, [], "q").ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(armIds("REVERSED", ranked, [], "q").ids).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(armIds("NONE", ranked, [], "q").ids).toEqual([]);
  });
  it("ORACLE puts evidence first without duplicates; RANDOM draws 10 distinct from the pool of 40", () => {
    expect(armIds("ORACLE", ranked, [33, 2], "q").ids).toEqual([33, 2, 1, 3, 4, 5, 6, 7, 8, 9]);
    expect(armIds("ORACLE-FULL", ranked, [33], "q").fullEvidence).toBe(true);
    const r = armIds("RANDOM", ranked, [], "q").ids;
    expect(new Set(r).size).toBe(10);
    expect(r.every((id) => id >= 1 && id <= 40)).toBe(true);
  });
  it("the block is cut on a line boundary at 4000 characters", () => {
    const b = memoryBlock(Array.from({ length: 30 }, () => "x".repeat(300)));
    expect(b.length).toBeLessThanOrEqual(4000);
    expect(b.split("\n").every((l) => l === "[Memory context]" || l.startsWith("Relevant") || l === "x".repeat(300))).toBe(true);
  });
  it("paired difference counts wins and losses and brackets the mean", () => {
    const d = pairedDiff([true, false, false, true], [true, true, true, false]);
    expect([d.wins, d.losses, d.ties]).toEqual([2, 1, 1]);
    expect(d.diff).toBeCloseTo(0.25);
    expect(d.lo).toBeLessThanOrEqual(d.diff);
    expect(d.hi).toBeGreaterThanOrEqual(d.diff);
  });
});
