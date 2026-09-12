/**
 * Zalo: the envelope, because the HTTP status lies here.
 *
 * Measured on 2026-09-12 against `bot-api.zaloplatforms.com` with a
 * deliberately invalid token: Zalo answers **HTTP 200** with
 * `{"ok":false,"description":"Unauthorized","error_code":401}`. Telegram
 * answers 401. Every other transport in this directory checks `res.ok`, and
 * that check is blind here: a wrong token would read as a successful request
 * carrying no messages, and the connector would report healthy for ever while
 * the person waits for a reply that cannot come.
 *
 * So the envelope reader is a pure function and this is what tests it.
 */

import { describe, expect, test } from "bun:test";
import { unwrapZalo, zaloSessionId, parseZaloSession } from "../src/transports/zalo.ts";

describe("the envelope decides, not the status code", () => {
  test("ok:true hands back the result", () => {
    expect(unwrapZalo(200, { ok: true, result: [{ update_id: 7 }] })).toEqual([{ update_id: 7 }]);
    expect(unwrapZalo(200, { ok: true, result: { id: "bot-1" } })).toEqual({ id: "bot-1" });
  });

  test("a missing result on ok:true is undefined, not an error", () => {
    // Some methods legitimately answer with no payload.
    expect(unwrapZalo(200, { ok: true })).toBeUndefined();
  });

  test("HTTP 200 with ok:false is a failure — the whole point of this file", () => {
    expect(() =>
      unwrapZalo(200, { ok: false, description: "Unauthorized", error_code: 401 }),
    ).toThrow();
  });

  test("a rejected token says what to do about it, and names the console", () => {
    // This exact body is what the live server returned to an invalid token.
    expect(() =>
      unwrapZalo(200, { ok: false, description: "Unauthorized", error_code: 401 }),
    ).toThrow(/rejected the bot token/);
    expect(() =>
      unwrapZalo(200, { ok: false, description: "Unauthorized", error_code: 401 }),
    ).toThrow(/bot\.zaloplatforms\.com/);
  });

  test("the rejected-token message is what the poll loop keys on to stop retrying", () => {
    // Coupling worth pinning: #poll() stops on this substring. If the wording
    // changes and this test is updated blindly, the loop silently goes back to
    // retrying a dead token for ever.
    let caught = "";
    try {
      unwrapZalo(200, { ok: false, description: "Unauthorized", error_code: 401 });
    } catch (e) {
      caught = String(e);
    }
    expect(caught).toContain("rejected the bot token");
  });

  test("any other failure carries Zalo's own words and code", () => {
    expect(() => unwrapZalo(200, { ok: false, description: "Too Many Requests", error_code: 429 })).toThrow(
      /Too Many Requests \(error 429\)/,
    );
    // No description: fall back to the status rather than throwing "undefined".
    expect(() => unwrapZalo(503, { ok: false })).toThrow(/HTTP 503 \(error 503\)/);
  });

  test("a body that is not an envelope at all is refused", () => {
    // A proxy, a captive portal or a maintenance page: HTML, or a bare array.
    for (const body of [null, "<html>maintenance</html>", 42, [1, 2, 3]]) {
      if (Array.isArray(body)) {
        // An array IS an object, so it reaches the envelope branch and fails
        // there for the right reason: no `ok:true`.
        expect(() => unwrapZalo(200, body)).toThrow();
      } else {
        expect(() => unwrapZalo(200, body)).toThrow(/is not a reply/);
      }
    }
  });
});

describe("session ids round-trip", () => {
  test("chat and user survive both directions", () => {
    expect(parseZaloSession(zaloSessionId("chat-9", "user-3"))).toEqual({
      chatId: "chat-9",
      userId: "user-3",
    });
  });

  test("another connector's session is not claimed", () => {
    expect(parseZaloSession("telegram:1:2")).toBeNull();
    expect(parseZaloSession("zalo:only-two")).toBeNull();
    expect(parseZaloSession("nostr:deadbeef")).toBeNull();
  });
});
