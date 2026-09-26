/**
 * Turning WhatsApp on is the person asking to link a phone, whichever surface
 * they used. Before 25 Sep only the chat started pairing: the desktop toggle
 * left it idle and "No pairing code is arriving" was all anyone saw.
 */
import { afterAll, expect, test } from "bun:test";
import { ConnectorManager, type AgentLike } from "../src/transports/connectors.ts";
import { registerTransport, transportFor } from "../src/transports/registry.ts";

const real = transportFor("whatsapp")!;
afterAll(() => registerTransport("whatsapp", real));

test("pairing starts when WhatsApp is turned on, not when the engine starts with it on", async () => {
  let pairs = 0;
  registerTransport("whatsapp", () => ({
    async start() {},
    async stop() {},
    health: () => ({ live: false }),
    async send() {},
    pair: async () => void pairs++,
  }) as never);
  const mgr = new ConnectorManager({ handleMessage: async () => "ok" } as unknown as AgentLike, () => {});
  const on = [{ id: "whatsapp", enabled: true, secrets: {} }];
  const off = [{ id: "whatsapp", enabled: false, secrets: {} }];

  await mgr.applyRows(on); // boot with it already on: stays idle
  expect(pairs).toBe(0);
  await mgr.applyRows(off);
  await mgr.applyRows(on); // the person turned it on
  expect(pairs).toBe(1);
  await mgr.applyRows(on); // an unrelated reload is not a new request
  expect(pairs).toBe(1);
});
