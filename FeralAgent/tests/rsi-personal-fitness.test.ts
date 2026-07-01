/**
 * Personal Fitness — the per-user signal that fills the
 * `userSatisfaction` component of the BRSI fitness vector (BRSI §2.10).
 *
 * Contract under test:
 *   1. `computePersonalFitness` returns 0.5 when there are no signals
 *      (the "neutral" default — same as `scoreToFitnessVector`).
 *   2. All-positive signals → userSatisfaction = 1.0.
 *   3. All-negative signals → userSatisfaction = 0.0.
 *   4. Mixed signals → result lies in (0, 1).
 *   5. The window filter drops signals older than `now - windowMs`.
 *   6. Custom weights override the defaults.
 *   7. `auditEntriesToUserSignals` only emits signals for `tool_call`
 *      entries (memory writes are NOT user-facing signals).
 *   8. `recallCountsToUserSignals` scales linearly with hits/misses.
 *   9. Default weights are sane (sum of magnitudes > 0; locked D4).
 */
import { describe, expect, test } from "bun:test";
import {
  auditEntriesToUserSignals,
  computePersonalFitness,
  DEFAULT_USER_SIGNAL_WEIGHTS,
  recallCountsToUserSignals,
  type UserSignal,
  type UserSignalKind,
} from "../src/rsi/personal-fitness.ts";

const NOW = 1_752_000_000_000; // fixed for determinism
const DAY = 24 * 60 * 60 * 1000;

describe("DEFAULT_USER_SIGNAL_WEIGHTS — sanity", () => {
  test("every kind has a defined weight (no zeros by accident)", () => {
    for (const kind of Object.keys(DEFAULT_USER_SIGNAL_WEIGHTS) as UserSignalKind[]) {
      expect(DEFAULT_USER_SIGNAL_WEIGHTS[kind]).not.toBe(0);
    }
  });

  test("all weights are positive magnitudes (sign comes from signal value)", () => {
    // Option B design: weight = magnitude; value carries sign.
    for (const kind of Object.keys(DEFAULT_USER_SIGNAL_WEIGHTS) as UserSignalKind[]) {
      expect(DEFAULT_USER_SIGNAL_WEIGHTS[kind]).toBeGreaterThan(0);
    }
  });

  test("rejection-style kinds have larger magnitudes than acceptance-style (penalty > reward)", () => {
    // BRSI §2.10 spirit: a single user edit-after-accept should hurt more
    // than one tool success helps. Default magnitudes encode this.
    expect(DEFAULT_USER_SIGNAL_WEIGHTS.edit_after_accept).toBeGreaterThan(
      DEFAULT_USER_SIGNAL_WEIGHTS.tool_success,
    );
    expect(DEFAULT_USER_SIGNAL_WEIGHTS.tool_error).toBeGreaterThan(
      DEFAULT_USER_SIGNAL_WEIGHTS.tool_success,
    );
  });
});

describe("computePersonalFitness — empty + extremes", () => {
  test("no signals → 0.5 (neutral)", () => {
    expect(computePersonalFitness({ signals: [], now: NOW })).toBe(0.5);
  });

  test("all-positive signals → 1.0", () => {
    const signals: UserSignal[] = [
      { timestamp: NOW - 1 * DAY, value: 1, kind: "tool_success" },
      { timestamp: NOW - 2 * DAY, value: 1, kind: "tool_success" },
      { timestamp: NOW - 3 * DAY, value: 1, kind: "acceptance" },
    ];
    expect(computePersonalFitness({ signals, now: NOW })).toBe(1);
  });

  test("all-negative signals → 0.0", () => {
    const signals: UserSignal[] = [
      { timestamp: NOW - 1 * DAY, value: -1, kind: "tool_error" },
      { timestamp: NOW - 2 * DAY, value: -1, kind: "edit_after_accept" },
    ];
    expect(computePersonalFitness({ signals, now: NOW })).toBe(0);
  });

  test("mixed signals → result in (0, 1)", () => {
    const signals: UserSignal[] = [
      { timestamp: NOW - 1 * DAY, value: 1, kind: "tool_success" },
      { timestamp: NOW - 2 * DAY, value: -1, kind: "tool_error" },
    ];
    const result = computePersonalFitness({ signals, now: NOW });
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });
});

describe("computePersonalFitness — window filter", () => {
  test("short window drops signals older than windowMs; long window keeps them", () => {
    const signals: UserSignal[] = [
      // 6 days old, inside any reasonable window
      { timestamp: NOW - 6 * DAY, value: 1, kind: "tool_success" },
      // 8 days old, inside a 14-day window, outside a 7-day window
      { timestamp: NOW - 8 * DAY, value: -1, kind: "tool_error" },
    ];
    // Short 7-day window: drops the 8-day-old negative → only the 6-day positive → 1.0
    const shortWindow = computePersonalFitness({
      signals,
      windowMs: 7 * DAY,
      now: NOW,
    });
    expect(shortWindow).toBe(1);
    // Long 14-day window: keeps both. The negative 8-day-old pulls it below 0.5.
    const longWindow = computePersonalFitness({
      signals,
      windowMs: 14 * DAY,
      now: NOW,
    });
    expect(longWindow).toBeLessThan(0.5);
  });

  test("all-signals-outside-window → 0.5 (neutral)", () => {
    const signals: UserSignal[] = [
      { timestamp: NOW - 100 * DAY, value: 1, kind: "tool_success" },
    ];
    expect(computePersonalFitness({ signals, windowMs: 7 * DAY, now: NOW })).toBe(0.5);
  });
});

describe("computePersonalFitness — weight overrides", () => {
  test("custom weights override defaults for the named kinds", () => {
    const signals: UserSignal[] = [
      { timestamp: NOW, value: 1, kind: "tool_success" },
      { timestamp: NOW, value: -1, kind: "tool_error" },
    ];
    // Without override: result somewhere in (0, 1) — slight negative bias.
    const defaultResult = computePersonalFitness({ signals, now: NOW });
    // Crank tool_error weight way up (Option B: weight is magnitude): result drops toward 0.
    const heavyPenalty = computePersonalFitness({
      signals,
      weights: { tool_error: 10 },
      now: NOW,
    });
    expect(heavyPenalty).toBeLessThan(defaultResult);
  });

  test("weight of 0 for a kind makes that kind's signals neutral", () => {
    const signals: UserSignal[] = [
      { timestamp: NOW, value: 1, kind: "tool_success" },
      { timestamp: NOW, value: -1, kind: "tool_error" },
    ];
    const neutralTool = computePersonalFitness({
      signals,
      weights: { tool_success: 0, tool_error: 0 },
      now: NOW,
    });
    expect(neutralTool).toBe(0.5);
  });
});

describe("auditEntriesToUserSignals", () => {
  test("tool_call success → tool_success signal", () => {
    const signals = auditEntriesToUserSignals([
      { timestamp: NOW, actionType: "tool_call", toolName: "read_file", result: "success" },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      timestamp: NOW,
      value: 1,
      kind: "tool_success",
      context: "read_file",
    });
  });

  test("tool_call error → tool_error signal with tool name as context", () => {
    const signals = auditEntriesToUserSignals([
      { timestamp: NOW, actionType: "tool_call", toolName: "write_file", result: "error" },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      timestamp: NOW,
      value: -1,
      kind: "tool_error",
      context: "write_file",
    });
  });

  test("memory_write entries are NOT surfaced (agent-internal, not user-facing)", () => {
    const signals = auditEntriesToUserSignals([
      { timestamp: NOW, actionType: "memory_write", result: "success" },
      { timestamp: NOW, actionType: "memory_write", result: "error" },
    ]);
    expect(signals).toEqual([]);
  });

  test("network / blocked / inference entries are NOT surfaced today", () => {
    const signals = auditEntriesToUserSignals([
      { timestamp: NOW, actionType: "network", result: "success" },
      { timestamp: NOW, actionType: "blocked", result: "blocked" },
      { timestamp: NOW, actionType: "inference", result: "success" },
    ]);
    expect(signals).toEqual([]);
  });

  test("missing result is treated as error (defensive)", () => {
    const signals = auditEntriesToUserSignals([
      { timestamp: NOW, actionType: "tool_call", toolName: "x" },
    ]);
    expect(signals[0]!.kind).toBe("tool_error");
  });
});

describe("recallCountsToUserSignals", () => {
  test("5 hits, 0 misses → 5 positive signals", () => {
    const signals = recallCountsToUserSignals({ timestamp: NOW, hits: 5, misses: 0 });
    expect(signals).toHaveLength(5);
    for (const s of signals) {
      expect(s.value).toBe(1);
      expect(s.kind).toBe("memory_reuse");
    }
  });

  test("0 hits, 3 misses → 3 negative signals", () => {
    const signals = recallCountsToUserSignals({ timestamp: NOW, hits: 0, misses: 3 });
    expect(signals).toHaveLength(3);
    for (const s of signals) {
      expect(s.value).toBe(-1);
      expect(s.kind).toBe("memory_reuse");
    }
  });

  test("hit/miss ratio drives userSatisfaction toward 1 or 0", () => {
    const mostlyHits = recallCountsToUserSignals({ timestamp: NOW, hits: 9, misses: 1 });
    const mostlyMisses = recallCountsToUserSignals({ timestamp: NOW, hits: 1, misses: 9 });
    expect(computePersonalFitness({ signals: mostlyHits, now: NOW })).toBeGreaterThan(0.5);
    expect(computePersonalFitness({ signals: mostlyMisses, now: NOW })).toBeLessThan(0.5);
  });
});

describe("end-to-end: mixed audit + recall → userSatisfaction", () => {
  test("positive audit + positive recall → high satisfaction", () => {
    const auditSignals = auditEntriesToUserSignals([
      { timestamp: NOW, actionType: "tool_call", toolName: "read_file", result: "success" },
      { timestamp: NOW, actionType: "tool_call", toolName: "grep", result: "success" },
    ]);
    const recallSignals = recallCountsToUserSignals({ timestamp: NOW, hits: 4, misses: 1 });
    const result = computePersonalFitness({
      signals: [...auditSignals, ...recallSignals],
      now: NOW,
    });
    expect(result).toBeGreaterThan(0.6);
  });

  test("negative audit + negative recall → low satisfaction", () => {
    const auditSignals = auditEntriesToUserSignals([
      { timestamp: NOW, actionType: "tool_call", toolName: "x", result: "error" },
      { timestamp: NOW, actionType: "tool_call", toolName: "y", result: "error" },
    ]);
    const recallSignals = recallCountsToUserSignals({ timestamp: NOW, hits: 1, misses: 5 });
    const result = computePersonalFitness({
      signals: [...auditSignals, ...recallSignals],
      now: NOW,
    });
    expect(result).toBeLessThan(0.4);
  });
});