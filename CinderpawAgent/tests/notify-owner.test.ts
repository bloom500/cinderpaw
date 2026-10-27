/**
 * A task that fires while the app sits in the tray reaches the owner on their
 * phone (27 Oct): the private chat with the first allowlisted person on a
 * connected messenger, phones first.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { ConnectorManager, ownerSession } from "../src/transports/connectors.ts";
import { registerTransport, transportFor, unregisterTransport } from "../src/transports/registry.ts";
import type { AgentLike } from "../src/transports/connectors.ts";
import type { ConnectorFactory } from "../src/transports/registry.ts";

const fakeAgent = (): AgentLike => ({ handleMessage: async () => "ok", registerProfile: () => {} }) as unknown as AgentLike;

// The real transports are process-global: replace two for this file, then put them back.
const saved = new Map<string, ConnectorFactory | undefined>(["telegram", "discord"].map((id) => [id, transportFor(id)]));
afterAll(() => {
  for (const [id, make] of saved) {
    if (make) registerTransport(id, make);
    else unregisterTransport(id);
  }
});

function fake(id: string, sent: string[], { live = true, fails = false } = {}): void {
  registerTransport(id, () => ({
    async start() {},
    async stop() {},
    health: () => ({ live }),
    async send(sessionId, text) {
      if (fails) throw new Error("blocked by the user");
      sent.push(`${sessionId}|${text}`);
    },
  }));
}

describe("notifyOwner", () => {
  it("each messenger's private chat with its owner", () => {
    expect(ownerSession("telegram", "4242")).toBe("telegram:4242:4242");
    expect(ownerSession("whatsapp", "+40 712 345 678")).toBe("whatsapp:40712345678@s.whatsapp.net");
    expect(ownerSession("discord", "99")).toBe("discord:dm:99");
  });

  it("goes to the phone messenger first, and says which one it used", async () => {
    const sent: string[] = [];
    fake("telegram", sent);
    fake("discord", sent);
    const mgr = new ConnectorManager(fakeAgent(), () => {});
    await mgr.applyRows([
      { id: "discord", enabled: true, secrets: {}, allowlist: ["99"] },
      { id: "telegram", enabled: true, secrets: {}, allowlist: ["4242", "777"] },
    ]);
    expect(await mgr.notifyOwner("⏰ Lalele\n\nPretul a scazut.")).toBe("telegram");
    expect(sent).toEqual(["telegram:4242:4242|⏰ Lalele\n\nPretul a scazut."]);
    await mgr.applyRows([]);
  });

  it("falls through a messenger that fails, and is null with nothing connected or no owner", async () => {
    const sent: string[] = [];
    fake("telegram", sent, { fails: true });
    fake("discord", sent);
    const mgr = new ConnectorManager(fakeAgent(), () => {});
    await mgr.applyRows([
      { id: "telegram", enabled: true, secrets: {}, allowlist: ["4242"] },
      { id: "discord", enabled: true, secrets: {}, allowlist: ["99"] },
    ]);
    expect(await mgr.notifyOwner("x")).toBe("discord");
    expect(sent).toEqual(["discord:dm:99|x"]);
    // An empty allowlist names nobody: nothing is sent anywhere.
    await mgr.applyRows([{ id: "discord", enabled: true, secrets: {}, allowlist: [] }]);
    expect(await mgr.notifyOwner("x")).toBeNull();
    await mgr.applyRows([]);
    expect(await mgr.notifyOwner("x")).toBeNull();
  });
});
