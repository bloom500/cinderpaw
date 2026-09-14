import { describe, expect, test } from "bun:test";
import { meanJaccard, sampleWithoutReplacement } from "../src/brain-substrate/bench/stages.ts";
import { mulberry32 } from "../src/memory/fractal/prng.ts";

describe("validation step 1 helpers", () => {
  test("mean Jaccard: identical sets 1, disjoint 0, half-shared 1/3", () => {
    expect(meanJaccard([new Set([1, 2]), new Set([1, 2])])).toBe(1);
    expect(meanJaccard([new Set([1]), new Set([2])])).toBe(0);
    expect(meanJaccard([new Set([1, 2]), new Set([2, 3])])).toBeCloseTo(1 / 3);
    expect(meanJaccard([new Set([1])])).toBe(0);
  });

  test("sampling draws k distinct items, is deterministic, and refuses k > n", () => {
    const names = Array.from({ length: 54 }, (_, i) => `g${i}`);
    const a = sampleWithoutReplacement(names, 8, mulberry32(1));
    expect(new Set(a).size).toBe(8);
    expect(sampleWithoutReplacement(names, 8, mulberry32(1))).toEqual(a);
    expect(() => sampleWithoutReplacement(names, 55, mulberry32(1))).toThrow();
  });
});
