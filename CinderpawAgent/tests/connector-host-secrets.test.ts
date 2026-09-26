/**
 * The host moves connector secrets out of connectors.json into the OS keychain
 * on every start, and sends them to us on the pipe. Measured 25 Sep: reading
 * the file alone brought a saved Telegram bot back up after a restart with
 * "enabled but no bot token". These pin that a re-read of the file keeps the
 * host's secrets, and that a secret the host drops is dropped here too.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorManager } from "../src/transports/connectors.ts";
import type { AgentLike } from "../src/transports/connectors.ts";
import { registerTransport, unregisterTransport } from "../src/transports/registry.ts";

const home = mkdtempSync(join(tmpdir(), "cp-host-secrets-"));
const prevHome = process.env.CINDERPAW_HOME;
const seen: (string | undefined)[] = [];

beforeAll(() => {
  process.env.CINDERPAW_HOME = home;
  // What the file looks like after the host's migration: the row, no secret.
  writeFileSync(
    join(home, "connectors.json"),
    JSON.stringify({ connectors: [{ id: "vaulty", enabled: true, secrets: {}, allowlist: ["1"] }] }),
  );
  registerTransport("vaulty", () => {
    let live = false;
    return {
      async start(ctx) {
        seen.push(ctx.secrets.VAULTY_TOKEN);
        if (!ctx.secrets.VAULTY_TOKEN) throw new Error("no token");
        live = true;
      },
      async stop() {
        live = false;
      },
      health: () => ({ live }),
      async send() {},
    };
  });
});

afterAll(() => {
  unregisterTransport("vaulty");
  if (prevHome === undefined) delete process.env.CINDERPAW_HOME;
  else process.env.CINDERPAW_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const agent = { handleMessage: async () => "ok", registerProfile: () => {} } as unknown as AgentLike;

describe("connector secrets that live in the host's keychain", () => {
  it("survive a re-read of a file that no longer holds them", async () => {
    const mgr = new ConnectorManager(agent, () => {});
    await mgr.setHostRows([{ id: "vaulty", enabled: true, secrets: { VAULTY_TOKEN: "t1" }, allowlist: ["1"] }]);
    expect(mgr.healthOf("vaulty")).toEqual({ live: true });
    expect(mgr.hasHostSecret("vaulty", "VAULTY_TOKEN")).toBe(true);

    // What connectors_manage does after an edit: re-read the file.
    await mgr.reload();
    expect(mgr.healthOf("vaulty")).toEqual({ live: true });
    expect(seen.filter((s) => s === undefined)).toEqual([]);

    // The person removed the token: the host stops sending it.
    await mgr.setHostRows([{ id: "vaulty", enabled: true, secrets: {}, allowlist: ["1"] }]);
    expect(mgr.hasHostSecret("vaulty", "VAULTY_TOKEN")).toBe(false);
    expect(mgr.healthOf("vaulty")?.live).toBe(false);
  });

  it("the first reload waits for the host, but not forever", async () => {
    const mgr = new ConnectorManager(agent, () => {});
    const t0 = Date.now();
    await mgr.hostRows(50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    setTimeout(() => void mgr.setHostRows([]), 10);
    const t1 = Date.now();
    await mgr.hostRows(5_000);
    expect(Date.now() - t1).toBeLessThan(1_000);
  });
});
