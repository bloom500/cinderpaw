/**
 * Constraint 6 of the phase: adding a connector must not require modifying
 * ConnectorManager.
 *
 * This registers a connector the manager has never heard of, from outside the
 * module, and drives it end to end. If someone later puts a fourth named field
 * back into the manager this test still passes — but the fifth connector will
 * need one too, and making that visible in review is the point.
 */

import { describe, expect, it } from "bun:test";
import { ConnectorManager } from "../src/transports/connectors.ts";
import { registerTransport } from "../src/transports/registry.ts";
import type { AgentLike } from "../src/transports/connectors.ts";

const fakeAgent = (): AgentLike =>
  ({
    handleMessage: async () => "ok",
    registerProfile: () => {},
  }) as unknown as AgentLike;

describe("adding a connector without touching the manager", () => {
  it("starts, reports health, sends and stops", async () => {
    const events: string[] = [];
    let live = false;
    registerTransport("acme", () => ({
      async start() {
        live = true;
        events.push("start");
      },
      async stop() {
        live = false;
        events.push("stop");
      },
      health: () => ({ live }),
      async send(sessionId, text) {
        events.push(`send:${sessionId}:${text}`);
      },
    }));

    const mgr = new ConnectorManager(fakeAgent(), () => {});
    await mgr.applyRows([{ id: "acme", enabled: true, secrets: {} }]);

    expect(events).toContain("start");
    expect(mgr.healthOf("acme")).toEqual({ live: true });

    await mgr.send("acme:room1:user1", "hello");
    expect(events).toContain("send:acme:room1:user1:hello");

    await mgr.applyRows([]);
    expect(events).toContain("stop");
    // Off by choice is not a failure — it disappears rather than going red.
    expect(mgr.healthOf("acme")).toBeUndefined();
  });

  it("does not restart a connector whose config did not change", async () => {
    let starts = 0;
    registerTransport("steady", () => ({
      async start() {
        starts += 1;
      },
      async stop() {},
      health: () => ({ live: true }),
      async send() {},
    }));

    const mgr = new ConnectorManager(fakeAgent(), () => {});
    const row = { id: "steady", enabled: true, secrets: {}, allowlist: ["a"] };
    await mgr.applyRows([row]);
    await mgr.applyRows([{ ...row }]);
    expect(starts).toBe(1);

    // …but a changed setting DOES take effect, without waiting for a restart.
    await mgr.applyRows([{ ...row, allowlist: ["a", "b"] }]);
    expect(starts).toBe(2);
    await mgr.stopAll();
  });

  it("says so when a connector has no transport in this build", async () => {
    // A catalog entry nobody implemented used to be silence: on in the file,
    // absent from the process, nothing on screen anywhere.
    const mgr = new ConnectorManager(fakeAgent(), () => {});
    await mgr.applyRows([{ id: "nosuch", enabled: true, secrets: {} }]);
    const h = mgr.healthOf("nosuch");
    expect(h?.live).toBe(false);
    expect(h?.error).toContain("no transport");
  });
});
