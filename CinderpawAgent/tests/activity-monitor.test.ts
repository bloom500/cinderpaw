/**
 * ActivityMonitor — the trigger inputs to the Dream Cycle scheduler.
 *
 * These tests pin the exact contract the scheduler will read:
 *   - `idleFor(nowMs)` returns the elapsed time since the last activity,
 *     or `+Infinity` if no activity has ever been recorded (the scheduler
 *     treats that as "as idle as possible" so a fresh boot can dream).
 *   - `errorsInWindow(nowMs)` counts only the errors whose timestamp is
 *     within `errorWindowMs` before `nowMs`, evicting older ones lazily.
 *   - Activity and errors are orthogonal counters — recording one does
 *     not reset the other. A long chatty session can still trip the
 *     error trigger, and a flapping engine can still be ignored while
 *     the user is hammering the agent.
 *
 * Time is passed in explicitly on every call so the assertions are
 * deterministic; no `Date.now()`, no `setTimeout`.
 */
import { describe, expect, test } from "bun:test";
import { ActivityMonitor } from "../src/rsi/l1-config/activity-monitor.ts";

const MIN = 60_000;

describe("ActivityMonitor.idleFor", () => {
  test("returns Infinity before any activity is recorded", () => {
    const m = new ActivityMonitor();
    expect(m.idleFor(0)).toBe(Number.POSITIVE_INFINITY);
    expect(m.idleFor(1_000_000)).toBe(Number.POSITIVE_INFINITY);
  });

  test("returns elapsed milliseconds since the last recordActivity", () => {
    const m = new ActivityMonitor();
    m.recordActivity(1000);
    expect(m.idleFor(4000)).toBe(3000);
    expect(m.idleFor(1000)).toBe(0);
    expect(m.idleFor(2000)).toBe(1000);
  });

  test("resets to 0 at the timestamp of the most recent activity", () => {
    const m = new ActivityMonitor();
    m.recordActivity(1000);
    m.recordActivity(5000);
    // The newer activity wins; idleFor is measured from the latest one.
    expect(m.idleFor(5000)).toBe(0);
    expect(m.idleFor(7000)).toBe(2000);
  });
});

describe("ActivityMonitor.errorsInWindow", () => {
  test("returns 0 before any error is recorded", () => {
    const m = new ActivityMonitor();
    expect(m.errorsInWindow(0)).toBe(0);
    expect(m.errorsInWindow(1_000_000_000)).toBe(0);
  });

  test("with the default 15-minute window, errors at t=0 and t=10min are both in the window at t=14min but only the t=10min one is at t=16min", () => {
    const m = new ActivityMonitor(); // default 15 * 60_000
    m.recordError(0);
    m.recordError(10 * MIN);
    // 14 minutes after the first error: the first is 14 min old (still in
    // a 15-min window), the second is 4 min old. Both count.
    expect(m.errorsInWindow(14 * MIN)).toBe(2);
    // 16 minutes after the first error: the first is 16 min old (evicted),
    // the second is 6 min old. Only one remains.
    expect(m.errorsInWindow(16 * MIN)).toBe(1);
  });

  test("honours a custom errorWindowMs", () => {
    const m = new ActivityMonitor({ errorWindowMs: 5 * MIN });
    m.recordError(0);
    m.recordError(4 * MIN);
    m.recordError(6 * MIN);
    // At t=7min: 0 is 7 min old (evicted), 4min is 3 min old (in),
    // 6min is 1 min old (in). 2 remain.
    expect(m.errorsInWindow(7 * MIN)).toBe(2);
    // At t=11min: only the 6min error survives (5 min old).
    expect(m.errorsInWindow(11 * MIN)).toBe(1);
  });

  test("evicts older errors on read so the in-memory list stays bounded", () => {
    const m = new ActivityMonitor({ errorWindowMs: 1 * MIN }); // 60s window
    // 100 errors spaced 1s apart, from t=0 to t=99s.
    for (let i = 0; i < 100; i++) m.recordError(i * 1000);
    // At t=150s the cutoff is t=90s — only the last 10 errors (t=90..99s)
    // should remain in the window. Eviction runs on this read, so a
    // subsequent identical read must agree.
    const firstCount = m.errorsInWindow(150_000);
    expect(firstCount).toBe(10);
    expect(m.errorsInWindow(150_000)).toBe(firstCount);
    // If we slide nowMs forward another 30s, the cutoff moves to t=120s
    // and the last 10 errors are also evicted — list is fully drained.
    expect(m.errorsInWindow(180_000)).toBe(0);
    // A fresh error recorded at t=200s is the only one in the window at t=200s.
    m.recordError(200_000);
    expect(m.errorsInWindow(200_000)).toBe(1);
  });
});

describe("ActivityMonitor — orthogonality of activity and errors", () => {
  test("recordActivity does NOT reset errors", () => {
    const m = new ActivityMonitor();
    m.recordError(0);
    m.recordError(30_000);
    m.recordActivity(60_000); // user comes back and starts chatting
    // The window is 15min; we're still well inside it. Both errors count.
    expect(m.errorsInWindow(60_000)).toBe(2);
    // The activity advanced idleFor to 0 — but the error log is untouched.
    expect(m.idleFor(60_000)).toBe(0);
    expect(m.errorsInWindow(60_000)).toBe(2); // still 2
  });

  test("recordError does NOT reset the idle clock", () => {
    const m = new ActivityMonitor();
    m.recordActivity(0);
    // 5 seconds later the engine trips, but the user is still actively
    // chatting — the idle clock should NOT jump.
    m.recordError(5_000);
    expect(m.idleFor(5_000)).toBe(5_000);
    m.recordError(8_000);
    expect(m.idleFor(8_000)).toBe(8_000); // still measured from the activity at t=0
    m.recordError(11_000);
    expect(m.idleFor(11_000)).toBe(11_000);
  });

  test("errors recorded before the first activity still count in the window", () => {
    const m = new ActivityMonitor();
    // Engine starts up, immediately errors twice before the user has said anything.
    m.recordError(0);
    m.recordError(1_000);
    expect(m.errorsInWindow(2_000)).toBe(2);
    // The user finally shows up at t=5s.
    m.recordActivity(5_000);
    expect(m.idleFor(5_000)).toBe(0);
    // The pre-boot errors are still in the window.
    expect(m.errorsInWindow(5_000)).toBe(2);
  });
});
