/**
 * CINDERPAW_RSI_STOP_ON_ACTIVITY — "Pause RSI when the user is active".
 *
 * The knob was parsed into `DreamConfig.stopOnActivity`, documented in the
 * config registry, and read by nothing: an operator who set it got an
 * episode that kept evaluating on their model while they typed. The Dream
 * Cycle now hands it to the scheduler, which stops an automatic episode once
 * the user has been active since it started. An episode the user asked for
 * (`user` trigger) is theirs and is left alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityMonitor } from "../src/rsi/l1-config/activity-monitor.ts";
import { createDreamCycle } from "../src/rsi/l1-config/dream-cycle.ts";
import { resolveDreamConfig } from "../src/rsi/l1-config/dream-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cinderpaw-dream-activity-"));
  dirs.push(dir);
  const monitor = new ActivityMonitor();
  const cycle = createDreamCycle({
    send: () => {},
    telemetryPath: join(dir, "dream.jsonl"),
    activityMonitor: monitor,
    config: resolveDreamConfig({ CINDERPAW_RSI_IDLE_MS: "50", CINDERPAW_RSI_POLL_MS: "60000", ...env }),
  });
  let running = false;
  let stops = 0;
  const engine = {
    start: async () => {
      running = true;
    },
    isRunning: () => running,
    stop: () => {
      stops += 1;
    },
  };
  const scheduler = cycle.arm(engine, {
    goal: "g",
    maxIterations: 1,
    maxTotalTokens: 1,
    maxTotalCostUsd: 0,
    concurrency: 1,
    maxWallClockMs: 60_000,
    plateauIterations: 1,
  });
  return { monitor, scheduler, stops: () => stops, running: () => running };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("stopOnActivity", () => {
  test("an idle episode is stopped once the user comes back", async () => {
    const h = setup({ CINDERPAW_RSI_STOP_ON_ACTIVITY: "true" });
    h.monitor.recordActivity(Date.now() - 1_000); // idle for a second
    await h.scheduler.tick();
    expect(h.running()).toBe(true);

    await sleep(5);
    h.monitor.recordActivity(Date.now()); // the user is back
    await h.scheduler.tick();
    expect(h.stops()).toBe(1);

    // Asked once, not on every poll while the engine drains.
    await h.scheduler.tick();
    expect(h.stops()).toBe(1);
  });

  test("off by default: the episode keeps running", async () => {
    const h = setup({});
    h.monitor.recordActivity(Date.now() - 1_000);
    await h.scheduler.tick();
    await sleep(5);
    h.monitor.recordActivity(Date.now());
    await h.scheduler.tick();
    expect(h.stops()).toBe(0);
  });

  test("an episode the user asked for is not stopped by their own activity", async () => {
    const h = setup({ CINDERPAW_RSI_STOP_ON_ACTIVITY: "true" });
    h.scheduler.requestUserDream();
    await h.scheduler.tick();
    expect(h.running()).toBe(true);
    await sleep(5);
    h.monitor.recordActivity(Date.now());
    await h.scheduler.tick();
    expect(h.stops()).toBe(0);
  });
});
