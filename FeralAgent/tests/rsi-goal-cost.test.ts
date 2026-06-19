// FeralAgent/tests/rsi-goal-cost.test.ts
import { describe, it, expect } from "bun:test";
import { estimateUsd, blendedPricePer1kUsd } from "../src/rsi/rsi-cost.ts";

// This test pins the cost-cap *decision* function in isolation. GoalMode
// exposes `costStop(totalCostUsd, maxTotalCostUsd)` as a pure static helper
// so the stop rule is testable without driving a full engine run.
import { costStop } from "../src/rsi/goal-mode.ts";

describe("GoalMode cost cap", () => {
  it("no cap (undefined) never stops on cost", () => {
    expect(costStop(9999, undefined)).toBe(false);
  });
  it("$0 cap = local-only: free run never stops, first paid token stops", () => {
    expect(costStop(0, 0)).toBe(false);      // local stays at 0 → keeps running
    expect(costStop(0.0001, 0)).toBe(true);  // any cloud spend halts
  });
  it("positive cap stops at or above the cap", () => {
    expect(costStop(1.99, 2)).toBe(false);
    expect(costStop(2.0, 2)).toBe(true);
    expect(costStop(2.5, 2)).toBe(true);
  });
  it("cost math is consistent with the estimator", () => {
    const price = blendedPricePer1kUsd("gpt-4o", false);
    expect(estimateUsd(1_000_000, price)).toBeGreaterThan(0);
  });
});
