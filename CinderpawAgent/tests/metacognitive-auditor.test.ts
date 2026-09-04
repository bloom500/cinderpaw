/**
 * metacognitive-auditor.test.ts — stagnation detection & assumption reset.
 * Runner-agnostic (bun:test → vitest fallback).
 */

interface RunnerLike {
  describe: (name: string, fn: () => void) => void;
  test: (name: string, fn: () => void | Promise<void>) => void;
  // biome-ignore lint/suspicious/noExplicitAny: structural runner typing
  expect: any;
}

async function loadRunner(): Promise<RunnerLike> {
  try {
    const mod = await import("bun:test");
    return { describe: mod.describe, test: mod.test, expect: mod.expect };
  } catch {
    const mod = await import("./_runner-vitest.ts");
    return { describe: mod.describe, test: mod.test ?? mod.it, expect: mod.expect };
  }
}

const { describe, test, expect } = await loadRunner();

import { MetacognitiveAuditor } from "../src/core/metacognitive-auditor.ts";

describe("MetacognitiveAuditor", () => {
  test("default threshold is 3 consecutive non-improving simulations", () => {
    const auditor = new MetacognitiveAuditor();
    expect(auditor.stagnationThreshold).toBe(3);
    expect(auditor.stagnationCount).toBe(0);
    expect(auditor.bestScore).toBe(null);
  });

  test("improving scores reset the streak and never fire", () => {
    const auditor = new MetacognitiveAuditor();
    let events = 0;
    auditor.onAssumptionReset(() => events++);
    for (const score of [0.1, 0.4, 0.2, 0.9, 0.9, 0.95]) {
      expect(auditor.recordScore(score)).toBe(null);
    }
    expect(events).toBe(0);
    expect(auditor.stagnationCount).toBe(0);
    expect(auditor.bestScore).toBe(0.95);
  });

  test("3 flat simulations after the baseline auto-fire exactly ONE stagnation reset", () => {
    const auditor = new MetacognitiveAuditor();
    auditor.addHypothesis("h-diagonal");
    auditor.addHypothesis("h-gravity");
    const seen = [];
    auditor.onAssumptionReset((e) => seen.push(e));

    expect(auditor.recordScore(0.5)).toBe(null); // baseline
    expect(auditor.recordScore(0.5)).toBe(null);
    expect(auditor.recordScore(0.5)).toBe(null);
    expect(auditor.stagnationCount).toBe(2);
    const event = auditor.recordScore(0.5);
    expect(event).not.toBe(null);
    expect(seen.length).toBe(1);

    expect(event.reason).toBe("stagnation");
    expect(event.stagnantScores).toEqual([0.5, 0.5, 0.5]);
    expect(event.clearedHypotheses).toEqual(["h-diagonal", "h-gravity"]);
    // The minted strategy IS the one the auditor now runs on.
    expect(event.newStrategyId).toBe(auditor.currentStrategyId);
    expect(event.iterationAtReset).toBe(4);

    // State cleaned up: hypotheses wiped, streak zeroed.
    expect(auditor.activeHypotheses).toEqual([]);
    expect(auditor.stagnationCount).toBe(0);
    expect(seen.length).toBe(1);
  });

  test("reset fires at most once per stagnation streak", () => {
    const auditor = new MetacognitiveAuditor();
    let fired = 0;
    auditor.onAssumptionReset(() => fired++);
    for (const _ of [0, 0, 0]) auditor.recordScore(0.3); // baseline + 2 stagnant
    expect(fired).toBe(0);
    auditor.recordScore(0.3); // 3rd stagnant → fire
    expect(fired).toBe(1);
    auditor.recordScore(0.3); // still flat, but already reset for this streak
    expect(fired).toBe(1);
    auditor.recordScore(0.8); // improvement re-arms the watcher
    auditor.recordScore(0.8);
    auditor.recordScore(0.8);
    auditor.recordScore(0.8);
    expect(fired).toBe(2);
  });

  test("manual triggerAssumptionReset works anytime and reports reason 'manual'", () => {
    const auditor = new MetacognitiveAuditor();
    auditor.addHypothesis("blocked-one");
    const event = auditor.triggerAssumptionReset();
    expect(event.reason).toBe("manual");
    expect(event.clearedHypotheses).toEqual(["blocked-one"]);
    expect(auditor.activeHypotheses).toEqual([]);
  });

  test("strategy id advances on each reset and forces a new token", () => {
    const auditor = new MetacognitiveAuditor();
    const first = auditor.currentStrategyId;
    const e1 = auditor.triggerAssumptionReset();
    const second = auditor.currentStrategyId;
    const e2 = auditor.triggerAssumptionReset();
    expect(second).not.toBe(first);
    expect(e1.newStrategyId).toBe(second);
    expect(e2.newStrategyId).not.toBe(second);
  });

  test("unsubscribe stops notifications", () => {
    const auditor = new MetacognitiveAuditor();
    let calls = 0;
    const off = auditor.onAssumptionReset(() => calls++);
    auditor.triggerAssumptionReset();
    off();
    auditor.triggerAssumptionReset();
    expect(calls).toBe(1);
  });

  test("custom threshold honored (stagnationThreshold 2)", () => {
    const auditor = new MetacognitiveAuditor({ stagnationThreshold: 2 });
    auditor.recordScore(0.5); // baseline
    auditor.recordScore(0.5);
    const event = auditor.recordScore(0.5);
    expect(event?.reason).toBe("stagnation");
  });

  test("minImprovementDelta counts tiny gains as stagnation when configured", () => {
    const auditor = new MetacognitiveAuditor({ minImprovementDelta: 0.1 });
    auditor.recordScore(0.5);
    auditor.recordScore(0.55); // +0.05 < delta → stagnant
    auditor.recordScore(0.55);
    const event = auditor.recordScore(0.55);
    expect(event?.reason).toBe("stagnation");
    expect(event?.stagnantScores).toEqual([0.55, 0.55, 0.55]);
  });

  test("loud on invalid usage", () => {
    const auditor = new MetacognitiveAuditor();
    expect(() => auditor.recordScore(Number.NaN)).toThrow(/finite/);
    expect(() => auditor.addHypothesis("")).toThrow(/non-empty string/);
    auditor.addHypothesis("dup-test");
    expect(() => auditor.addHypothesis("dup-test")).toThrow(/already registered/);
    expect(() => auditor.onAssumptionReset(undefined as never)).toThrow(/must be a function/);
    expect(() => new MetacognitiveAuditor({ stagnationThreshold: 0 })).toThrow(
      /integer ≥ 1/,
    );
    expect(() => new MetacognitiveAuditor({ minImprovementDelta: -1 })).toThrow(/finite ≥ 0/);
  });
});
