/**
 * One Cinderpaw across chats: the desktop told Darius "I can't confirm" about
 * the WhatsApp chat it had held ten minutes before (1 Nov 2026).
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorLine, elsewhereNote, hearsElsewhere, markOwnerChat, ownsChat, setAppOwners } from "../src/memory/elsewhere.ts";
import type { EpisodicEvent } from "../src/types.ts";

const DESK = "9787edf9-37ae-4ba4-abcc-ae4afceccec5";
const SELF = "whatsapp:58643651260498@lid";
const FRIEND = "whatsapp:40700000000@s.whatsapp.net";
const now = 1_800_000_000_000;
const ev = (sessionId: string, role: "user" | "assistant", content: string, minAgo: number, id: number): EpisodicEvent =>
  ({ id, sessionId, role, content, timestamp: now - minAgo * 60_000 }) as EpisodicEvent;

test("the desktop sees the owner's WhatsApp chat, never a friend's", () => {
  markOwnerChat(SELF);
  const rows = [
    ev(FRIEND, "user", "secret plans of a friend", 2, 5),
    ev(SELF, "assistant", "Salut Darius, sunt aici", 9, 4),
    ev(SELF, "user", "Esti aici cu mine?", 10, 3),
  ];
  const note = elsewhereNote(DESK, () => rows, now);
  expect(note).toContain("In WhatsApp, 9 min ago");
  expect(note.indexOf("Them: Esti aici")).toBeLessThan(note.indexOf("You: Salut Darius"));
  expect(note).not.toContain("friend");
});

test("WhatsApp hears about the desktop, and a guest hears nothing", () => {
  markOwnerChat(SELF);
  expect(ownsChat(SELF)).toBe(true);
  expect(ownsChat(DESK)).toBe(true);
  expect(ownsChat(FRIEND)).toBe(false);
  expect(ownsChat("cron:daily")).toBe(false);
  expect(elsewhereNote(SELF, () => [ev(DESK, "user", "fa-mi un raport", 30, 1)], now)).toContain("In another desktop chat, 30 min ago");
});

test("one rule finds the owner on every app, and never answers the note into a group", () => {
  setAppOwners(new Map([["telegram", "111"], ["signal", "+40 712 345 678"], ["msteams", "29:me"], ["discord", "42"]]));
  const teams = (conv: string, user: string) =>
    `msteams:${Buffer.from(conv).toString("base64url")}:${Buffer.from(user).toString("base64url")}`;
  expect(hearsElsewhere("telegram:111:111")).toBe(true); // private chat
  expect(ownsChat("telegram:-100555:111")).toBe(true); // the owner in a group...
  expect(hearsElsewhere("telegram:-100555:111")).toBe(false); // ...gets no note there
  expect(hearsElsewhere("telegram:222:222")).toBe(false); // someone else
  expect(hearsElsewhere("signal:+40712345678")).toBe(true); // same number, other spelling
  expect(hearsElsewhere("discord:dm:42")).toBe(true);
  expect(ownsChat(teams("19:room@thread", "29:me"))).toBe(true);
  expect(hearsElsewhere(FRIEND)).toBe(false);
  // The app's owner changes with the config: the old one is no longer you.
  setAppOwners(new Map());
  expect(ownsChat("telegram:111:111")).toBe(false);
});

test("nothing said elsewhere means no note at all", () => {
  expect(elsewhereNote(DESK, () => [], now)).toBe("");
});

test("the chat apps line says plainly which one is not connected", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cp-health-")), "h.json");
  writeFileSync(file, JSON.stringify({ connectors: { whatsapp: { live: false, error: "not linked yet" }, discord: { live: true } } }));
  const line = connectorLine(file);
  expect(line).toContain("WhatsApp NOT connected (not linked yet)");
  expect(line).toContain("Discord connected");
  expect(connectorLine(join(tmpdir(), "no-such-health.json"))).toBe("");
});
