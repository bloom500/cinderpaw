/**
 * Dream Cycle — the scheduler that replaces the continuous PassiveSupervisor.
 *
 * The old supervisor relaunched the engine ~5s after every run end, forever
 * (token burn). The DreamScheduler instead runs ONE bounded episode, then
 * SLEEPS until a trigger fires:
 *   - idle: the user has been inactive for `idleThresholdMs`;
 *   - error: real failures crossed `errorThreshold` within the monitor window.
 * Between episodes a `cooldownMs` prevents thrashing. All time + signals are
 * injected so the lifecycle is deterministic — no real timers, no engine.
 */

import { describe, expect, test } from "bun:test";
import { DreamScheduler } from "../src/rsi/dream-scheduler.ts";

function harness(overrides: Partial<Parameters<typeof DreamScheduler.prototype.constructor>[0]> = {}) {
  let running = false;
  const starts: Array<"idle" | "error"> = [];
  const signals = { idle: 0, errors: 0, now: 0 };
  const sched = new DreamScheduler({
    start: async (trigger) => {
      starts.push(trigger);
      running = true;
    },
    isRunning: () => running,
    idleForMs: () => signals.idle,
    errorsInWindow: () => signals.errors,
    now: () => signals.now,
    idleThresholdMs: 1000,
    cooldownMs: 5000,
    errorThreshold: 3,
    ...overrides,
  });
  return {
    sched,
    starts,
    signals,
    setRunning: (v: boolean) => {
      running = v;
    },
  };
}

describe("DreamScheduler — trigger decisions", () => {
  test("launches an episode once the user is idle past the threshold", async () => {
    const h = harness();
    h.signals.idle = 1500; // > 1000
    await h.sched.tick();
    expect(h.starts).toEqual(["idle"]);
  });

  test("does NOT launch while below the idle threshold and no errors", async () => {
    const h = harness();
    h.signals.idle = 500; // < 1000
    await h.sched.tick();
    expect(h.starts).toEqual([]);
  });

  test("does NOT launch a second episode while one is already running", async () => {
    const h = harness();
    h.signals.idle = 2000;
    await h.sched.tick();
    await h.sched.tick();
    expect(h.starts).toEqual(["idle"]); // only one
  });

  test("launches on the error trigger even when the user is active", async () => {
    const h = harness();
    h.signals.idle = 0; // active
    h.signals.errors = 3; // >= threshold
    await h.sched.tick();
    expect(h.starts).toEqual(["error"]);
  });
});

describe("DreamScheduler — sleep + cooldown", () => {
  test("after a run ends, cooldown blocks a relaunch until it elapses", async () => {
    const h = harness();
    h.signals.now = 0;
    h.signals.idle = 2000;
    await h.sched.tick(); // launch #1
    expect(h.starts.length).toBe(1);

    // Run ends at t=0; cooldown is 5000.
    h.setRunning(false);
    h.sched.onRunEnded();

    // Still idle, but inside cooldown → no relaunch.
    h.signals.now = 3000;
    h.signals.idle = 3000;
    await h.sched.tick();
    expect(h.starts.length).toBe(1);

    // Past cooldown → relaunch allowed.
    h.signals.now = 6000;
    h.signals.idle = 6000;
    await h.sched.tick();
    expect(h.starts.length).toBe(2);
  });

  test("shutdown() stops all further launches", async () => {
    const h = harness();
    h.sched.shutdown();
    h.signals.idle = 9999;
    await h.sched.tick();
    expect(h.starts).toEqual([]);
  });
});
