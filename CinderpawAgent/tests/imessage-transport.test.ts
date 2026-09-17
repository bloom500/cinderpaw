/**
 * iMessage through a fake `imsg rpc` bridge.
 *
 * The bridge is JSON-RPC over lines, so the fake is a pair of callbacks: it
 * answers `status`, `watch.subscribe` and `send`, and can push a `message`
 * notification. What is pinned: the refusal off macOS, the readiness check,
 * the allowlist, own messages skipped, the reply into the same chat.
 */

import { describe, expect, test } from "bun:test";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { ImessageConnector, imessageSessionId, parseImessageSession, type Bridge } from "../src/transports/imessage.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";

function fakeBridge(opts: { dbReady?: boolean } = {}) {
  let onLine: (l: string) => void = () => {};
  const sent: Array<{ chat_id: number; text: string }> = [];
  const bridge: Bridge = {
    write(line) {
      const req = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
      const reply = (result: unknown) => setTimeout(() => onLine(JSON.stringify({ jsonrpc: "2.0", id: req.id, result })), 0);
      if (req.method === "status") reply({ db_ready: opts.dbReady ?? true });
      else if (req.method === "watch.subscribe") reply({ subscription: 1 });
      else if (req.method === "send") {
        sent.push(req.params as { chat_id: number; text: string });
        reply({ ok: true, id: 1 });
      }
    },
    onLine: (cb) => { onLine = cb; },
    onExit: () => {},
    kill: () => {},
  };
  const push = (message: Record<string, unknown>) =>
    onLine(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1, message } }));
  return { bridge, sent, push };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

function ctx(handled: string[], logs: string[], over: Partial<ConnectorContext["row"]> = {}): ConnectorContext {
  return {
    row: { id: "imessage", enabled: true, allowlist: ["+40700000001", "Friend@Example.com"], ...over },
    secrets: {},
    agent: {
      async handle(sessionId, t) {
        handled.push(`${sessionId}|${t}`);
        return "the answer";
      },
    },
    log: (m) => logs.push(m),
    runs: null,
    askRouter: new ChannelAskRouter(),
  };
}

describe("iMessage", () => {
  test("session ids", () => {
    expect(imessageSessionId(42, "+1")).toBe("imessage:42:+1");
    expect(parseImessageSession("imessage:42:+1")).toEqual({ chatId: "42", sender: "+1" });
    expect(parseImessageSession("signal:+1")).toBeNull();
  });

  test("off macOS it refuses with the reason, before spawning anything", async () => {
    let spawned = false;
    const c = new ImessageConnector({ platform: "win32", spawn: () => { spawned = true; return fakeBridge().bridge; } });
    await expect(c.start(ctx([], []))).rejects.toThrow(/only works on a Mac/);
    expect(spawned).toBe(false);
  });

  test("a bridge that cannot read the database is named, with the permission to grant", async () => {
    const c = new ImessageConnector({ platform: "darwin", spawn: () => fakeBridge({ dbReady: false }).bridge });
    await expect(c.start(ctx([], []))).rejects.toThrow(/Full Disk Access/);
  });

  test("a bridge that cannot be started says how to install it", async () => {
    const c = new ImessageConnector({ platform: "darwin", spawn: () => { throw new Error("ENOENT"); } });
    await expect(c.start(ctx([], []))).rejects.toThrow(/brew install steipete\/tap\/imsg/);
  });

  test("an allowlisted sender is answered in the same chat; own and stranger messages are not", async () => {
    const fb = fakeBridge();
    const handled: string[] = [];
    const logs: string[] = [];
    const c = new ImessageConnector({ platform: "darwin", spawn: () => fb.bridge });
    await c.start(ctx(handled, logs));
    expect(c.health()).toEqual({ live: true });

    fb.push({ id: 1, chat_id: 42, sender: "+40700000001", text: "hello", is_from_me: false });
    fb.push({ id: 2, chat_id: 42, sender: "+40700000001", text: "me", is_from_me: true });
    fb.push({ id: 3, chat_id: 42, sender: "+40700000009", text: "stranger", is_from_me: false });
    fb.push({ id: 4, chat_id: 7, sender: "friend@example.com", text: "by email", is_from_me: false });
    await settle();
    expect(handled).toEqual([
      "imessage:42:+40700000001|[user:+40700000001] hello",
      "imessage:7:friend@example.com|[user:friend@example.com] by email",
    ]);
    expect(fb.sent).toEqual([{ chat_id: 42, text: "the answer" }, { chat_id: 7, text: "the answer" }]);
    expect(logs.some((l) => l.includes("non-allowlisted +40700000009"))).toBe(true);
    await c.stop();
  });

  test("a redelivered message id is handled once", async () => {
    const fb = fakeBridge();
    const handled: string[] = [];
    const c = new ImessageConnector({ platform: "darwin", spawn: () => fb.bridge });
    await c.start(ctx(handled, []));
    fb.push({ id: 9, chat_id: 1, sender: "+40700000001", text: "again" });
    fb.push({ id: 9, chat_id: 1, sender: "+40700000001", text: "again" });
    await settle();
    expect(handled).toHaveLength(1);
    await c.stop();
  });
});
