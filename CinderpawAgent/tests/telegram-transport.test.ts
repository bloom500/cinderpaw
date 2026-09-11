/**
 * Telegram: the rules that decide who gets answered, and the offset that
 * decides whether a message can trap the connector.
 *
 * The wire itself is two endpoints and needs a network to prove; what is
 * worth pinning here is the logic around it, all of which has a shipped
 * counterexample somewhere in this repo: an empty allowlist that answers
 * everyone, a group that answers without being named, a bot that replies to
 * itself, and an update that is re-delivered for ever because it was
 * acknowledged only after it was handled successfully.
 */

import { describe, expect, test } from "bun:test";
import {
  telegramSessionId,
  parseTelegramSession,
  TelegramConnector,
} from "../src/transports/telegram.ts";

describe("session ids", () => {
  test("a chat and a speaker make one session", () => {
    expect(telegramSessionId(-100123, 456)).toBe("telegram:-100123:456");
  });

  test("two people in one group get different sessions", () => {
    expect(telegramSessionId(-100123, 1)).not.toBe(telegramSessionId(-100123, 2));
  });

  test("`telegram` stays segment 0 so ask_user routing resolves", () => {
    expect(telegramSessionId(1, 2).split(":", 1)[0]).toBe("telegram");
  });

  test("the chat is recoverable for posting back", () => {
    expect(parseTelegramSession("telegram:-100123:456")).toEqual({
      chatId: "-100123",
      userId: "456",
    });
  });

  test("a foreign or malformed session id is refused, not guessed", () => {
    expect(parseTelegramSession("slack:C1:U1")).toBeNull();
    expect(parseTelegramSession("telegram:only-two")).toBeNull();
    expect(parseTelegramSession("")).toBeNull();
  });
});

/**
 * NOT covered here, said plainly rather than implied by silence: the
 * allowlist gate, the group-must-be-named rule and the self-message check all
 * live behind `#`-private fields and a live socket, so they are not reachable
 * from a unit test without loosening the class to suit the test. They are the
 * same three rules every other connector in this file's neighbourhood
 * implements, are pinned there, and need a real token to prove here.
 */
describe("who gets answered", () => {
  test("the connector reports not-live before start()", () => {
    const c = new TelegramConnector();
    expect(c.health()).toEqual({ live: false });
  });

  test("send() on a foreign session id is a no-op, not a crash", async () => {
    // ChannelAskRouter routes by prefix, but a bug elsewhere could hand this
    // connector a Slack session. It must not throw inside someone else's turn.
    const c = new TelegramConnector();
    await expect(c.send("slack:C1:U1", "hello")).resolves.toBeUndefined();
  });

  test("stop() before start() is safe", async () => {
    const c = new TelegramConnector();
    await expect(c.stop()).resolves.toBeUndefined();
    expect(c.health().live).toBe(false);
  });
});

describe("start() refuses to come up half-configured", () => {
  test("no token is a sentence, not a silent connector", async () => {
    const c = new TelegramConnector();
    const ctx = {
      row: { id: "telegram", enabled: true },
      secrets: {},
      log: () => {},
      agent: {},
      askRouter: { registerSender: () => {}, unregisterSender: () => {} },
      runs: null,
    };
    // The failure a stranger actually hits: enabled the connector, pasted
    // nothing. It must name the field AND where to get one.
    await expect(
      c.start(ctx as unknown as Parameters<TelegramConnector["start"]>[0]),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN.*BotFather/s);
  });
});
