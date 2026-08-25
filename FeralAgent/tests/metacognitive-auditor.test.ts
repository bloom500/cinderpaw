import { describe, expect, it, vi } from "vitest";
import { MetacognitiveAuditor } from "../src/core/metacognitive-auditor.js";

describe("Metacognitive Auditor", () => {
  it("tracks scores and resets on stagnation threshold", () => {
    const auditor = new MetacognitiveAuditor({ stagnationThreshold: 3 });
    const onReset = vi.fn();
    auditor.onReset(onReset);

    // Initial good run
    expect(auditor.evaluateIterationScore(0.5)).toBe(false);

    // 2 stagnant runs
    expect(auditor.evaluateIterationScore(0.5)).toBe(false);
    expect(auditor.evaluateIterationScore(0.5)).toBe(false);

    // 3rd stagnant run triggers reset
    expect(auditor.evaluateIterationScore(0.5)).toBe(true);
    expect(onReset).toHaveBeenCalledWith("stagnation", 0.5);

    const stats = auditor.getStats();
    expect(stats.resetTriggeredCount).toBe(1);
  });

  it("resets stagnation count when score improves", () => {
    const auditor = new MetacognitiveAuditor({ stagnationThreshold: 3 });

    auditor.evaluateIterationScore(0.2);
    auditor.evaluateIterationScore(0.2); // 1 stagnant
    auditor.evaluateIterationScore(0.8); // Improved!

    const stats = auditor.getStats();
    expect(stats.consecutiveStagnantRuns).toBe(0);
    expect(stats.bestScore).toBe(0.8);
  });
});
