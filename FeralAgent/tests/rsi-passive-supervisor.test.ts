/**
 * Passive RSI — the background-engine supervisor.
 *
 * The evolutionary engine runs passively by default: it autostarts when
 * the sidecar boots with a real model and restarts itself whenever a run
 * ends, so a non-technical user gets a self-improving agent without ever
 * opening /rsi or touching a config. These tests pin the pure decision
 * logic + the restart loop with injected scheduling — no engine, no
 * model, no timers.
 */

import { describe, expect, test } from "bun:test";
import {
  shouldAutostartPassive,
  passiveStartOptions,
  PassiveSupervisor,
  STANDING_GOAL,
} from "../src/rsi/passive-supervisor.ts";

describe("shouldAutostartPassive", () => {
  test("enabled with a real model", () => {
    const d = shouldAutostartPassive({ FERAL_MODEL: "gemma-4-e4b-it" });
    expect(d.enabled).toBe(true);
  });

  test("disabled via FERAL_RSI_PASSIVE=false (the kill switch)", () => {
    const d = shouldAutostartPassive({ FERAL_MODEL: "gemma-4", FERAL_RSI_PASSIVE: "false" });
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain("disabled");
  });

  test("disabled when no real model is configured (placeholder)", () => {
    expect(shouldAutostartPassive({ FERAL_MODEL: "feral-local" }).enabled).toBe(false);
    expect(shouldAutostartPassive({ FERAL_MODEL: "" }).enabled).toBe(false);
    expect(shouldAutostartPassive({}).enabled).toBe(false);
  });
});

describe("passiveStartOptions", () => {
  test("standing goal + sensible continuous defaults", () => {
    const o = passiveStartOptions({});
    expect(o.goal).toBe(STANDING_GOAL);
    expect(o.maxIterations).toBeGreaterThan(1000); // effectively continuous
    expect(o.maxTotalTokens).toBeGreaterThan(1_000_000);
    expect(o.concurrency).toBe(1); // capped low by default
  });

  test("env overrides are honoured and concurrency is clamped to 1..4", () => {
    const o = passiveStartOptions({
      FERAL_RSI_MAX_ITER: "500",
      FERAL_RSI_CONCURRENCY: "99",
    });
    expect(o.maxIterations).toBe(500);
    expect(o.concurrency).toBe(4); // clamped
  });

  test("garbage env values fall back to defaults", () => {
    const o = passiveStartOptions({ FERAL_RSI_MAX_ITER: "abc", FERAL_RSI_CONCURRENCY: "-3" });
    expect(o.maxIterations).toBeGreaterThan(1000);
    expect(o.concurrency).toBe(1);
  });
});

describe("passiveStartOptions cost cap", () => {
  test("defaults to $0 (local-only) when FERAL_RSI_MAX_COST_USD is unset", () => {
    const o = passiveStartOptions({ FERAL_MODEL: "feral-local-7b" });
    expect(o.maxTotalCostUsd).toBe(0);
  });
  test("reads a positive cap from the env", () => {
    const o = passiveStartOptions({ FERAL_MODEL: "gpt-4o", FERAL_RSI_MAX_COST_USD: "2.5" });
    expect(o.maxTotalCostUsd).toBe(2.5);
  });
  test("honors an explicit $0 cap", () => {
    const o = passiveStartOptions({ FERAL_RSI_MAX_COST_USD: "0" });
    expect(o.maxTotalCostUsd).toBe(0);
  });
  test("treats a malformed cap as $0 (safe default)", () => {
    const o = passiveStartOptions({ FERAL_MODEL: "x", FERAL_RSI_MAX_COST_USD: "abc" });
    expect(o.maxTotalCostUsd).toBe(0);
  });
});

describe("PassiveSupervisor — autostart + restart loop", () => {
  function harness() {
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    let starts = 0;
    let running = false;
    const sup = new PassiveSupervisor({
      start: async () => {
        starts += 1;
        running = true;
      },
      isRunning: () => running,
      schedule: (cb, ms) => scheduled.push({ cb, ms }),
      restartDelayMs: 5000,
    });
    return {
      sup,
      scheduled,
      starts: () => starts,
      setRunning: (v: boolean) => {
        running = v;
      },
    };
  }

  test("begin() starts the engine when idle", async () => {
    const h = harness();
    await h.sup.begin();
    expect(h.starts()).toBe(1);
  });

  test("begin() is a no-op when already running", async () => {
    const h = harness();
    await h.sup.begin();
    await h.sup.begin();
    expect(h.starts()).toBe(1);
  });

  test("onRunEnded schedules a restart that re-begins", async () => {
    const h = harness();
    await h.sup.begin();
    h.setRunning(false); // the run finished
    h.sup.onRunEnded();
    expect(h.scheduled.length).toBe(1);
    expect(h.scheduled[0]!.ms).toBe(5000);
    h.scheduled[0]!.cb(); // fire the timer
    await Promise.resolve();
    expect(h.starts()).toBe(2);
  });

  test("shutdown() stops the restart loop", async () => {
    const h = harness();
    await h.sup.begin();
    h.setRunning(false);
    h.sup.shutdown();
    h.sup.onRunEnded();
    expect(h.scheduled.length).toBe(0); // no restart scheduled after shutdown
  });

  test("begin() after shutdown is a no-op", async () => {
    const h = harness();
    h.sup.shutdown();
    await h.sup.begin();
    expect(h.starts()).toBe(0);
  });

  test("a start that throws schedules a retry", async () => {
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    let attempts = 0;
    const sup = new PassiveSupervisor({
      start: async () => {
        attempts += 1;
        throw new Error("model not ready");
      },
      isRunning: () => false,
      schedule: (cb, ms) => scheduled.push({ cb, ms }),
      restartDelayMs: 1000,
    });
    await sup.begin();
    expect(attempts).toBe(1);
    expect(scheduled.length).toBe(1); // retry scheduled
  });
});
