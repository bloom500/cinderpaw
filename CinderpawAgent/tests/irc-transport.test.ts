/**
 * IRC: the line parser, the byte budget, and the newline that would be a
 * command injection.
 *
 * All three are pure functions on purpose, so the parts that can actually
 * hurt someone are testable without a socket. The chunker and the stripper
 * are the security boundary of the transport: everything the agent says goes
 * through them before it reaches the wire.
 */

import { describe, expect, test } from "bun:test";
import {
  stripIrcControlChars,
  ircMessageChunks,
  parseIrcLine,
  ircSessionId,
  parseIrcSession,
} from "../src/transports/irc.ts";

describe("control characters cannot reach the wire", () => {
  test("CR and LF are removed", () => {
    // The attack: get the agent to repeat this, and everything after the
    // newline is read by the server as a fresh command.
    const evil = "hello\r\nJOIN #attacker-channel";
    expect(stripIrcControlChars(evil)).toBe("helloJOIN #attacker-channel");
    expect(stripIrcControlChars(evil)).not.toContain("\n");
    expect(stripIrcControlChars(evil)).not.toContain("\r");
  });

  test("every other C0 control and DEL go too", () => {
    expect(stripIrcControlChars("abcd")).toBe("abcd");
  });

  test("ordinary text, accents and emoji are untouched", () => {
    expect(stripIrcControlChars("bună ziua 🐾")).toBe("bună ziua 🐾");
  });

  test("a reply containing a newline cannot produce a second command", () => {
    // End to end through the chunker, which is what send() actually calls.
    const chunks = ircMessageChunks("#room", "ok\r\nQUIT :bye");
    expect(chunks.join("")).not.toMatch(/[\r\n]/);
  });
});

describe("the 512-byte line budget", () => {
  test("a short message is one chunk, unchanged", () => {
    expect(ircMessageChunks("#room", "hello there")).toEqual(["hello there"]);
  });

  test("no chunk can overrun the line limit once framed", () => {
    const target = "#a-fairly-long-channel-name";
    for (const text of [
      "x".repeat(2000),
      "cuvânt ".repeat(300),
      "🐾".repeat(400), // four bytes each: the case a character count misses
    ]) {
      for (const chunk of ircMessageChunks(target, text)) {
        const line = Buffer.byteLength(`PRIVMSG ${target} :${chunk}\r\n`, "utf8");
        expect(line).toBeLessThanOrEqual(512);
      }
    }
  });

  test("nothing is lost across the chunks", () => {
    const text = "unu doi trei patru cinci ".repeat(40).trim();
    const joined = ircMessageChunks("#room", text).join(" ");
    expect(joined.replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  test("a longer target name leaves less room, and that is respected", () => {
    const short = ircMessageChunks("#a", "y".repeat(1000));
    const long = ircMessageChunks("#".padEnd(60, "z"), "y".repeat(1000));
    expect(long.length).toBeGreaterThanOrEqual(short.length);
  });

  test("an unbreakable run is cut rather than dropped", () => {
    const chunks = ircMessageChunks("#room", "z".repeat(900));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").length).toBe(900);
  });
});

describe("line parsing", () => {
  test("a channel message yields sender, target and text", () => {
    const line = parseIrcLine(":darius!~d@host PRIVMSG #room :hello world");
    expect(line).toEqual({
      prefix: "darius!~d@host",
      command: "PRIVMSG",
      params: ["#room", "hello world"],
    });
  });

  test("the trailing parameter keeps its spaces and its colons", () => {
    const line = parseIrcLine(":s PRIVMSG #r :a : b : c");
    expect(line?.params[1]).toBe("a : b : c");
  });

  test("a server line has no prefix", () => {
    expect(parseIrcLine("PING :1234")).toEqual({ command: "PING", params: ["1234"] });
  });

  test("the command is upper-cased so the switch cannot miss it", () => {
    expect(parseIrcLine(":s privmsg #r :hi")?.command).toBe("PRIVMSG");
  });

  test("junk is refused rather than half-parsed", () => {
    expect(parseIrcLine("")).toBeNull();
    expect(parseIrcLine("   ")).toBeNull();
    expect(parseIrcLine(":only-a-prefix")).toBeNull();
  });
});

describe("session ids", () => {
  test("a channel message is keyed by channel AND speaker", () => {
    expect(ircSessionId("#room", "darius")).toBe("irc:#room:darius");
    expect(ircSessionId("#room", "a")).not.toBe(ircSessionId("#room", "b"));
  });

  test("`irc` stays segment 0 so ask_user routing resolves", () => {
    expect(ircSessionId("#r", "n").split(":", 1)[0]).toBe("irc");
  });

  test("round trip", () => {
    expect(parseIrcSession("irc:#room:darius")).toEqual({ target: "#room", nick: "darius" });
  });

  test("a foreign session id is refused", () => {
    expect(parseIrcSession("telegram:1:2")).toBeNull();
    expect(parseIrcSession("irc:incomplete")).toBeNull();
  });
});
