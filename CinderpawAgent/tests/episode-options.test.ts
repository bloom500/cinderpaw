/**
 * Episode options — the bounded run config a Dream Cycle episode runs with.
 *
 * These tests pin two contracts:
 *   1. Empty env → exact defaults. The scheduler and engine assume these
 *      values when no operator override is set, so they must be stable.
 *   2. Every env knob (a) honours a valid value and (b) falls back to
 *      the default on anything that doesn't parse — same `positive` /
 *      `nonNegative` discipline as `passive-supervisor.ts`. The cost cap
 *      is the one exception that accepts 0 explicitly (it's the meaningful
 *      "local-only" sentinel, not a missing value).
 *   3. `concurrency` is clamped to the same 1..4 window as the passive
 *      engine so a runaway override can't starve the chat.
 */
import { describe, expect, test } from "bun:test";
import {
  episodeStartOptions,
  STANDING_GOAL,
} from "../src/rsi/l1-config/episode-options.ts";

describe("episodeStartOptions — defaults", () => {
  test("empty env yields exactly the documented defaults", () => {
    const o = episodeStartOptions({});
    expect(o.goal).toBe(STANDING_GOAL);
    expect(o.maxIterations).toBe(40);
    expect(o.maxTotalTokens).toBe(2_000_000);
    expect(o.maxTotalCostUsd).toBe(0);
    expect(o.concurrency).toBe(1);
    expect(o.maxWallClockMs).toBe(8 * 60_000);
    expect(o.plateauIterations).toBe(12);
  });

  test("STANDING_GOAL is the frozen passive-engine text, unchanged", () => {
    // The dream must optimise against the same objective the passive
    // engine already chases — if this drifts the two engines will fight.
    expect(STANDING_GOAL).toBe(
      "Continuously improve the agent's general-purpose configuration: maximise answer " +
        "quality and reliability across the eval suite while minimising token cost and latency.",
    );
    // And every episode gets it for free.
    expect(episodeStartOptions({}).goal).toBe(STANDING_GOAL);
  });
});

describe("episodeStartOptions — env overrides", () => {
  test("CINDERPAW_RSI_MAX_ITER overrides maxIterations", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_MAX_ITER: "10" }).maxIterations).toBe(10);
    expect(episodeStartOptions({ CINDERPAW_RSI_MAX_ITER: "500" }).maxIterations).toBe(500);
  });

  test("CINDERPAW_RSI_MAX_TOKENS overrides maxTotalTokens", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_MAX_TOKENS: "100000" }).maxTotalTokens).toBe(100_000);
  });

  test("CINDERPAW_RSI_EPISODE_MS overrides maxWallClockMs", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_EPISODE_MS: "120000" }).maxWallClockMs).toBe(120_000);
  });

  test("CINDERPAW_RSI_PLATEAU_ITERS overrides plateauIterations", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_PLATEAU_ITERS: "3" }).plateauIterations).toBe(3);
  });

  test("all knobs can be set together and don't bleed into each other", () => {
    const o = episodeStartOptions({
      CINDERPAW_RSI_MAX_ITER: "7",
      CINDERPAW_RSI_MAX_TOKENS: "8000",
      CINDERPAW_RSI_MAX_COST_USD: "1.25",
      CINDERPAW_RSI_CONCURRENCY: "2",
      CINDERPAW_RSI_EPISODE_MS: "30000",
      CINDERPAW_RSI_PLATEAU_ITERS: "5",
    });
    expect(o).toEqual({
      goal: STANDING_GOAL,
      maxIterations: 7,
      maxTotalTokens: 8_000,
      maxTotalCostUsd: 1.25,
      concurrency: 2,
      maxWallClockMs: 30_000,
      plateauIterations: 5,
    });
  });
});

describe("episodeStartOptions — invalid values fall back to defaults", () => {
  test("non-numeric strings fall back to the default", () => {
    const o = episodeStartOptions({
      CINDERPAW_RSI_MAX_ITER: "abc",
      CINDERPAW_RSI_MAX_TOKENS: "many",
      CINDERPAW_RSI_EPISODE_MS: "",
      CINDERPAW_RSI_PLATEAU_ITERS: "NaN",
    });
    expect(o.maxIterations).toBe(40);
    expect(o.maxTotalTokens).toBe(2_000_000);
    expect(o.maxWallClockMs).toBe(8 * 60_000);
    expect(o.plateauIterations).toBe(12);
  });

  test("zero and negative values fall back to the default (positive parser)", () => {
    // The positive parser treats 0 as "missing" — you can't ask for
    // "0 iterations" or "0 tokens" in a meaningful way.
    const o = episodeStartOptions({
      CINDERPAW_RSI_MAX_ITER: "0",
      CINDERPAW_RSI_MAX_TOKENS: "-5",
      CINDERPAW_RSI_EPISODE_MS: "0",
      CINDERPAW_RSI_PLATEAU_ITERS: "-1",
    });
    expect(o.maxIterations).toBe(40);
    expect(o.maxTotalTokens).toBe(2_000_000);
    expect(o.maxWallClockMs).toBe(8 * 60_000);
    expect(o.plateauIterations).toBe(12);
  });

  test("Infinity and NaN fall back to the default", () => {
    const o = episodeStartOptions({
      CINDERPAW_RSI_MAX_ITER: "Infinity",
      CINDERPAW_RSI_MAX_TOKENS: "NaN",
    });
    expect(o.maxIterations).toBe(40);
    expect(o.maxTotalTokens).toBe(2_000_000);
  });
});

describe("episodeStartOptions — cost cap (the nonNegative exception)", () => {
  test("empty env → 0 (local-only default)", () => {
    expect(episodeStartOptions({}).maxTotalCostUsd).toBe(0);
  });

  test("explicit 0 is honoured — operators can pin to local-only", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_MAX_COST_USD: "0" }).maxTotalCostUsd).toBe(0);
  });

  test("negative values fall back to 0 (nonNegative refuses < 0)", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_MAX_COST_USD: "-1" }).maxTotalCostUsd).toBe(0);
  });

  test("positive values pass through (including fractional)", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_MAX_COST_USD: "5" }).maxTotalCostUsd).toBe(5);
    expect(episodeStartOptions({ CINDERPAW_RSI_MAX_COST_USD: "0.25" }).maxTotalCostUsd).toBe(0.25);
  });

  test("malformed strings fall back to 0", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_MAX_COST_USD: "free" }).maxTotalCostUsd).toBe(0);
  });
});

describe("episodeStartOptions — concurrency clamp", () => {
  test("default is 1 when env is empty", () => {
    expect(episodeStartOptions({}).concurrency).toBe(1);
  });

  test("explicit values in 1..4 are honoured", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_CONCURRENCY: "2" }).concurrency).toBe(2);
    expect(episodeStartOptions({ CINDERPAW_RSI_CONCURRENCY: "4" }).concurrency).toBe(4);
  });

  test("values above 4 are clamped down to 4", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_CONCURRENCY: "9" }).concurrency).toBe(4);
    expect(episodeStartOptions({ CINDERPAW_RSI_CONCURRENCY: "99" }).concurrency).toBe(4);
  });

  test("values below 1 (including 0) are clamped up to 1", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_CONCURRENCY: "0" }).concurrency).toBe(1);
    expect(episodeStartOptions({ CINDERPAW_RSI_CONCURRENCY: "-3" }).concurrency).toBe(1);
  });

  test("non-numeric values fall back to the default of 1", () => {
    expect(episodeStartOptions({ CINDERPAW_RSI_CONCURRENCY: "abc" }).concurrency).toBe(1);
  });

  test("fractional values are floored before clamping", () => {
    // 2.9 → floor → 2 → clamp → 2.
    expect(episodeStartOptions({ CINDERPAW_RSI_CONCURRENCY: "2.9" }).concurrency).toBe(2);
  });
});
