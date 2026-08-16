// FeralAgent/tests/rsi-cost.test.ts
import { describe, it, expect } from "bun:test";
import {
  blendedPricePer1kUsd,
  estimateUsd,
  knownPricePer1kUsd,
} from "../src/rsi/infra/rsi-cost.ts";

describe("rsi-cost", () => {
  it("local (loopback) is always free regardless of model id", () => {
    expect(blendedPricePer1kUsd("anything", true)).toBe(0);
    expect(blendedPricePer1kUsd("gpt-4o", true)).toBe(0);
  });

  it("unknown cloud model falls back to the conservative default price", () => {
    expect(blendedPricePer1kUsd("some-unknown-model", false)).toBeGreaterThan(0);
  });

  it("known cloud model uses its override price", () => {
    // gpt-4o override is cheaper than the conservative default.
    const known = blendedPricePer1kUsd("gpt-4o", false);
    const unknown = blendedPricePer1kUsd("zzz-unknown", false);
    expect(known).toBeGreaterThan(0);
    expect(known).toBeLessThan(unknown);
  });

  it("fails closed for autonomous cloud work when the model has no known price", () => {
    expect(knownPricePer1kUsd("some-unknown-model", false)).toBeNull();
    expect(knownPricePer1kUsd("gpt-4o", false)).toBeGreaterThan(0);
    expect(knownPricePer1kUsd("some-unknown-model", true)).toBe(0);
  });

  it("estimateUsd scales linearly with tokens", () => {
    expect(estimateUsd(0, 5)).toBe(0);
    expect(estimateUsd(1000, 5)).toBeCloseTo(5, 6);
    expect(estimateUsd(2500, 4)).toBeCloseTo(10, 6);
  });
});
