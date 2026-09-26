/** isLinked reads creds.json: a QR scan is linked, a half-finished pairing is not. */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppConnector } from "../src/transports/connectors.ts";

const home = mkdtempSync(join(tmpdir(), "wa-linked-"));
const prev = process.env.CINDERPAW_HOME;
process.env.CINDERPAW_HOME = home;
afterAll(() => {
  if (prev === undefined) delete process.env.CINDERPAW_HOME;
  else process.env.CINDERPAW_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const creds = (c: object) => {
  mkdirSync(join(home, "whatsapp-auth"), { recursive: true });
  writeFileSync(join(home, "whatsapp-auth", "creds.json"), JSON.stringify(c));
};

test("a QR-linked phone is linked although `registered` stays false", () => {
  creds({ registered: false, me: { id: "40700000000:12@s.whatsapp.net" }, account: { details: "x" } });
  expect(WhatsAppConnector.isLinked()).toBe(true);
});

test("a phone-number code link is linked", () => {
  creds({ registered: true, me: { id: "40700000000@s.whatsapp.net" } });
  expect(WhatsAppConnector.isLinked()).toBe(true);
});

test("an opened socket nobody scanned is not linked", () => {
  creds({ registered: false });
  expect(WhatsAppConnector.isLinked()).toBe(false);
  rmSync(join(home, "whatsapp-auth"), { recursive: true });
  expect(WhatsAppConnector.isLinked()).toBe(false);
});
