/**
 * Signal: the number normaliser, and the message a first-run user gets when
 * the bridge they never installed is not there.
 *
 * The second one is the reason this connector was worth writing now. Signal
 * is the first of the 21 that cannot work on a fresh machine, and the whole
 * difference between a good and a bad first run is whether the reason
 * reaches the screen or a log file.
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeSignalNumber,
  signalBridgeMissingMessage,
  signalSessionId,
  parseSignalSession,
  SignalConnector,
} from "../src/transports/signal.ts";

describe("the missing-bridge message", () => {
  const msg = signalBridgeMissingMessage("http://127.0.0.1:8080");

  test("it names the address it looked at", () => {
    expect(msg).toContain("http://127.0.0.1:8080");
  });

  test("it names the thing to install, not just the failure", () => {
    expect(msg).toContain("signal-cli-rest-api");
    expect(msg).toMatch(/https:\/\/github\.com\/\S+/);
  });

  test("it explains why something must be installed at all", () => {
    // Without this a user reasonably concludes Cinderpaw is broken.
    expect(msg).toMatch(/no bot API/i);
  });

  test("it says what to do if the port is different", () => {
    expect(msg).toContain("SIGNAL_BRIDGE_URL");
  });
});

describe("phone numbers", () => {
  test("the usual shapes all normalise to one", () => {
    for (const input of ["+40 712 345 678", "0040712345678", "+40712345678", "40-712-345-678"]) {
      expect(normalizeSignalNumber(input)).toMatch(/^\+\d+$/);
    }
    expect(normalizeSignalNumber("+40 712 345 678")).toBe("+40712345678");
  });

  test("an allowlist entry and an inbound sender normalise the same way", () => {
    // The bug this prevents: the user types "+40 712 345 678" in settings,
    // Signal delivers "+40712345678", and the gate silently never matches.
    expect(normalizeSignalNumber("+40 712 345 678")).toBe(normalizeSignalNumber("+40712345678"));
  });

  test("something that is not a number yields nothing, not a wrong target", () => {
    expect(normalizeSignalNumber("")).toBe("");
    expect(normalizeSignalNumber("   ")).toBe("");
    expect(normalizeSignalNumber("darius")).toBe("");
  });
});

describe("session ids", () => {
  test("the number is the person: two segments, no channel", () => {
    expect(signalSessionId("+40712345678")).toBe("signal:+40712345678");
  });

  test("`signal` stays segment 0 so ask_user routing resolves", () => {
    expect(signalSessionId("+40712345678").split(":", 1)[0]).toBe("signal");
  });

  test("round trip, and foreign ids refused", () => {
    expect(parseSignalSession("signal:+40712345678")).toEqual({ number: "+40712345678" });
    expect(parseSignalSession("telegram:1:2")).toBeNull();
    expect(parseSignalSession("signal:")).toBeNull();
  });
});

describe("start() fails loudly, not silently", () => {
  const ctx = (secrets: Record<string, string>) => ({
    row: { id: "signal", enabled: true },
    secrets,
    log: () => {},
    agent: {},
    askRouter: { registerSender: () => {}, unregisterSender: () => {} },
    runs: null,
  });

  test("no number names the field and the format", async () => {
    const c = new SignalConnector();
    await expect(
      c.start(ctx({}) as unknown as Parameters<SignalConnector["start"]>[0]),
    ).rejects.toThrow(/SIGNAL_NUMBER.*country code/s);
  });

  test("a bridge that is not running produces the install message", async () => {
    // A refused connection, without the network: the earlier version dialled
    // 127.0.0.1:1 and the macOS CI runner answered it (something there
    // accepts the connection), so start() resolved and the test failed for a
    // reason that had nothing to do with Signal.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    try {
      const c = new SignalConnector();
      await expect(
        c.start(
          ctx({
            SIGNAL_NUMBER: "+40712345678",
            SIGNAL_BRIDGE_URL: "http://127.0.0.1:1",
          }) as unknown as Parameters<SignalConnector["start"]>[0],
        ),
      ).rejects.toThrow(/signal-cli-rest-api/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("it reports not-live before start and after stop", async () => {
    const c = new SignalConnector();
    expect(c.health()).toEqual({ live: false });
    await c.stop();
    expect(c.health().live).toBe(false);
  });
});
