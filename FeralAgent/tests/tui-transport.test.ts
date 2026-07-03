/**
 * TuiTransport — slice 5.1 tests.
 *
 * Tests the in-process fan-out transport without I/O:
 *   - onEvent subscription + unsubscription
 *   - send fans out to all subscribers
 *   - sendInboundAsMessage dispatches to onMessage handler
 *   - sendInboundAsMessage ignores empty messages
 *   - single subscriber error does not break others
 */

import { describe, expect, test, mock } from "bun:test";
import { TuiTransport } from "../src/transports/tui.ts";

describe("TuiTransport", () => {
  // ——— Construction ———
  test("can be constructed", () => {
    const t = new TuiTransport();
    expect(t).toBeInstanceOf(TuiTransport);
  });

  // ——— onEvent ———
  test("onEvent subscriber receives send() events", () => {
    const t = new TuiTransport();
    const handler = mock<(e: unknown) => void>();
    t.onEvent(handler);
    t.send({ type: "pong" });
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0];
    expect(event).toEqual({ type: "pong" });
  });

  test("onEvent subscriber can be unsubscribed", () => {
    const t = new TuiTransport();
    const handler = mock<(e: unknown) => void>();
    const unsub = t.onEvent(handler);
    unsub();
    t.send({ type: "pong" });
    expect(handler).not.toHaveBeenCalled();
  });

  test("multiple subscribers all receive events", () => {
    const t = new TuiTransport();
    const h1 = mock<(e: unknown) => void>();
    const h2 = mock<(e: unknown) => void>();
    t.onEvent(h1);
    t.onEvent(h2);
    t.send({ type: "pong" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  test("one subscriber throwing does not block others", () => {
    const t = new TuiTransport();
    const throwing = () => { throw new Error("oops"); };
    const h2 = mock<(e: unknown) => void>();
    t.onEvent(throwing);
    t.onEvent(h2);
    // Must not throw
    t.send({ type: "pong" });
    expect(h2).toHaveBeenCalledTimes(1);
  });

  // ——— sendInboundAsMessage ———
  test("sendInboundAsMessage dispatches 'message' to onMessage handler", () => {
    const t = new TuiTransport();
    const handler = mock<(msg: unknown) => void>();
    t.onMessage(handler);
    t.sendInboundAsMessage("hello world");
    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(msg.type).toBe("message");
    expect(msg.content).toBe("hello world");
    expect(typeof msg.id).toBe("string");
  });

  test("sendInboundAsMessage with empty string is ignored", () => {
    const t = new TuiTransport();
    const handler = mock<(msg: unknown) => void>();
    t.onMessage(handler);
    t.sendInboundAsMessage("");
    expect(handler).not.toHaveBeenCalled();
  });

  test("sendInboundAsMessage with whitespace-only is ignored", () => {
    const t = new TuiTransport();
    const handler = mock<(msg: unknown) => void>();
    t.onMessage(handler);
    t.sendInboundAsMessage("   ");
    expect(handler).not.toHaveBeenCalled();
  });

  // ——— start ———
  test("start fires onReady on next tick", async () => {
    const t = new TuiTransport();
    const ready = mock<() => void>();
    t.onReady(ready);
    t.start();
    // Must not have fired synchronously
    expect(ready).not.toHaveBeenCalled();
    // Wait a microtask
    await Promise.resolve();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  test("start is idempotent", () => {
    const t = new TuiTransport();
    const ready = mock<() => void>();
    t.onReady(ready);
    t.start();
    t.start();
    t.start();
    // Still only queued once
    expect(ready).not.toHaveBeenCalled(); // microtask hasn't fired yet
  });
});