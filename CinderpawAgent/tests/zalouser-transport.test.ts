/**
 * Zalo personal account: the one 14 Sep transport that had no test of its
 * own. Nobody here has a real Zalo account to pair, so this pins what can be
 * pinned without one: a saved session restores without a QR, an allowlisted
 * sender gets the agent's answer back on the same thread, a stranger is
 * ignored and said so in the log, and the account-suspension warning is the
 * first thing the person reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";
import {
  ZALOUSER_WARNING,
  ZalouserConnector,
  parseZalouserSession,
  zalouserSessionId,
  type ZaloApi,
  type ZaloMessage,
} from "../src/transports/zalouser.ts";

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let home: string;
let originalHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cinderpaw-zalouser-"));
  originalHome = process.env.CINDERPAW_HOME;
  process.env.CINDERPAW_HOME = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.CINDERPAW_HOME;
  else process.env.CINDERPAW_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function fakeApi(sent: { text: string; threadId: string; type: number }[]) {
  const handlers: Record<string, ((...a: never[]) => void)[]> = {};
  const api: ZaloApi = {
    listener: {
      on(event: string, cb: (...a: never[]) => void) {
        (handlers[event] ??= []).push(cb);
      },
      start() {},
      stop() {},
    } as ZaloApi["listener"],
    async sendMessage(text, threadId, type) {
      sent.push({ text, threadId, type });
    },
    getOwnId: () => "me-1",
    getCookie: () => ({ toJSON: () => ({ cookies: [] }) }),
  };
  const deliver = (m: ZaloMessage) => {
    for (const cb of handlers.message ?? []) (cb as (m: ZaloMessage) => void)(m);
  };
  return { api, deliver };
}

describe("session ids", () => {
  test("round-trip", () => {
    expect(parseZalouserSession(zalouserSessionId("t-1", "u-9"))).toEqual({ threadId: "t-1", userId: "u-9" });
    expect(parseZalouserSession("zalouser:only-one")).toBeNull();
    expect(parseZalouserSession("zalo:t:u")).toBeNull();
  });
});

describe("a saved session comes back without a QR", () => {
  test("allowlisted sender gets the answer on the same thread; a stranger is named in the log", async () => {
    writeFileSync(join(home, "zalouser-session.json"), JSON.stringify({ imei: "i", cookie: {}, userAgent: "ua" }));
    const sent: { text: string; threadId: string; type: number }[] = [];
    const { api, deliver } = fakeApi(sent);
    let qrAsked = 0;
    const c = new ZalouserConnector({
      client: async () => ({
        login: async () => api,
        loginQR: async () => {
          qrAsked += 1;
          return api;
        },
      }),
      open: () => {},
    });
    const logs: string[] = [];
    const handled: string[] = [];
    const ctx: ConnectorContext = {
      row: { id: "zalouser", enabled: true, allowlist: ["friend-1"] },
      secrets: {},
      agent: { async handle(sessionId, t) { handled.push(`${sessionId}|${t}`); return "the answer"; } },
      log: (m) => logs.push(m),
      runs: null,
      askRouter: new ChannelAskRouter(),
    };
    await c.start(ctx);

    expect(qrAsked).toBe(0);
    expect(c.health()).toEqual({ live: true });
    expect(logs[0]).toBe(ZALOUSER_WARNING);

    deliver({ type: 0, threadId: "friend-1", isSelf: false, data: { msgId: "m1", uidFrom: "friend-1", content: "hello" } });
    deliver({ type: 0, threadId: "nobody-2", isSelf: false, data: { msgId: "m2", uidFrom: "nobody-2", content: "hi", dName: "Stranger" } });
    await settle();

    expect(handled).toEqual(["zalouser:friend-1:friend-1|[user:friend-1] hello"]);
    expect(sent).toEqual([{ text: "the answer", threadId: "friend-1", type: 0 }]);
    expect(logs.some((l) => l.includes("non-allowlisted nobody-2 (Stranger)"))).toBe(true);

    await c.stop();
    expect(c.health().live).toBe(false);
  });

  test("an empty allowlist says on start that nobody can reach it", async () => {
    writeFileSync(join(home, "zalouser-session.json"), JSON.stringify({ imei: "i", cookie: {}, userAgent: "ua" }));
    const { api } = fakeApi([]);
    const c = new ZalouserConnector({ client: async () => ({ login: async () => api, loginQR: async () => api }), open: () => {} });
    const logs: string[] = [];
    await c.start({
      row: { id: "zalouser", enabled: true },
      secrets: {},
      agent: { async handle() { return ""; } },
      log: (m) => logs.push(m),
      runs: null,
      askRouter: new ChannelAskRouter(),
    });
    expect(logs.some((l) => l.includes("NOBODY CAN REACH IT"))).toBe(true);
    await c.stop();
  });
});
