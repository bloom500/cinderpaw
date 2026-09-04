/**
 * P2-#1: liveness heartbeat.
 *
 * The HeartbeatLoop fires a periodic `heartbeat` OutboundEvent so the
 * Tauri shell knows the sidecar is alive. The heartbeat carries
 * uptime, RSS memory, and active-session count.
 */

import { describe, expect, test } from "bun:test";
import { HeartbeatLoop } from "../src/core/heartbeat.ts";
import type { OutboundEvent } from "../src/types.ts";

describe("HeartbeatLoop (P2-#1)", () => {
  test("snapshot has uptime, rssMb, activeSessions", () => {
    const hb = new HeartbeatLoop({ getActiveSessions: () => 7 });
    const snap = hb.snapshot();
    expect(snap.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(snap.rssMb).toBeGreaterThanOrEqual(0);
    expect(snap.activeSessions).toBe(7);
  });

  test("emitNow fires a heartbeat event with the current snapshot", () => {
    const events: OutboundEvent[] = [];
    const hb = new HeartbeatLoop({ getActiveSessions: () => 3 });
    hb.setEmit((e) => events.push(e));
    hb.emitNow();
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.type).toBe("heartbeat");
    if (ev.type === "heartbeat") {
      expect(ev.activeSessions).toBe(3);
      expect(ev.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(ev.rssMb).toBeGreaterThanOrEqual(0);
    }
  });

  test("start() fires a heartbeat within ~intervalMs", async () => {
    const events: OutboundEvent[] = [];
    const hb = new HeartbeatLoop({
      intervalMs: 30,
      getActiveSessions: () => 1,
    });
    hb.setEmit((e) => events.push(e));
    hb.start();
    await new Promise((r) => setTimeout(r, 80));
    hb.stop();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.type).toBe("heartbeat");
  });

  test("start() is idempotent — calling twice doesn't double-fire", async () => {
    const events: OutboundEvent[] = [];
    const hb = new HeartbeatLoop({
      intervalMs: 30,
      getActiveSessions: () => 0,
    });
    hb.setEmit((e) => events.push(e));
    hb.start();
    hb.start(); // no-op
    hb.start(); // no-op
    await new Promise((r) => setTimeout(r, 80));
    hb.stop();
    // Roughly 2-3 heartbeats in 80ms with 30ms interval, not 6-9.
    expect(events.length).toBeLessThan(5);
  });

  test("stop() halts the heartbeat", async () => {
    const events: OutboundEvent[] = [];
    const hb = new HeartbeatLoop({
      intervalMs: 20,
      getActiveSessions: () => 0,
    });
    hb.setEmit((e) => events.push(e));
    hb.start();
    await new Promise((r) => setTimeout(r, 50));
    hb.stop();
    const countAtStop = events.length;
    // Wait more — no new events after stop.
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(countAtStop);
  });

  test("setInterval() updates the cadence at runtime", () => {
    const hb = new HeartbeatLoop({ intervalMs: 1000 });
    hb.setInterval(500);
    // Smoke: snapshot still works after the change.
    expect(hb.snapshot().uptimeMs).toBeGreaterThanOrEqual(0);
  });
});
