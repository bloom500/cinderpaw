/**
 * WhatsApp must not pair unless someone asked it to.
 *
 * Observed on a real boot: an enabled connector with no linked phone opened a
 * socket anyway, Baileys started pairing, nothing scanned the code, and it
 * retried — 47 reconnect cycles in the first 90 seconds, each writing several
 * lines to the gateway log. Left overnight that is a log nobody can read and a
 * core spinning for a QR nobody requested.
 */
import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppConnector } from "../src/transports/connectors.ts";

const original = process.env.CINDERPAW_HOME;
const made: string[] = [];

afterEach(() => {
  if (original === undefined) delete process.env.CINDERPAW_HOME;
  else process.env.CINDERPAW_HOME = original;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A CINDERPAW_HOME whose whatsapp-auth holds exactly `creds`, or nothing. */
function homeWith(creds: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "cinderpaw-wa-"));
  made.push(home);
  if (creds !== null) {
    mkdirSync(join(home, "whatsapp-auth"), { recursive: true });
    writeFileSync(join(home, "whatsapp-auth", "creds.json"), creds, "utf8");
  }
  process.env.CINDERPAW_HOME = home;
  return home;
}

test("a fresh install is not linked", () => {
  homeWith(null);
  expect(WhatsAppConnector.isLinked()).toBe(false);
});

test("credentials from a phone that finished scanning count as linked", () => {
  homeWith(JSON.stringify({ registered: true, me: { id: "40700000000:1@s.whatsapp.net" } }));
  expect(WhatsAppConnector.isLinked()).toBe(true);
});

test("a half-finished pairing is NOT linked", () => {
  // Baileys writes creds.json the moment a socket opens, before any phone has
  // scanned anything. Treating file-exists as linked would put exactly the
  // abandoned pairing that caused the retry storm straight back into the loop.
  homeWith(JSON.stringify({ registered: false }));
  expect(WhatsAppConnector.isLinked()).toBe(false);
});

test("unreadable credentials are not a link", () => {
  homeWith("{ this is not json");
  expect(WhatsAppConnector.isLinked()).toBe(false);
});

test("an unlinked connector stays idle at boot and says how to link it", async () => {
  homeWith(null);
  const lines: string[] = [];
  const conn = new WhatsAppConnector({
    allowlist: [],
    channels: [],
    agent: { handle: async () => "" },
    log: (m: string) => lines.push(m),
  });

  // Returns rather than opening a socket. If this ever regresses, the test does
  // not hang — it fails on the absent log line, and the retry storm is back.
  await conn.start();

  expect(lines.some((l) => l.includes("no phone is linked"))).toBe(true);
  // The user is told what to DO. A connector that goes quiet without saying why
  // is indistinguishable from one that is broken.
  expect(lines.some((l) => l.includes("/connectors qr"))).toBe(true);
  await conn.stop();
});
