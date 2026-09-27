import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import {
  ObservationStore, importLegacyNotes, legacyNoteText, weekPeriod,
} from "../src/memory/observations.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 23, 12); // Wednesday 23 Sep 2026

function store() {
  const db = openDatabase(":memory:");
  return { db, s: new ObservationStore(db.raw) };
}
const note = (sessionId: string, observedAt: number, text: string, priority: "high" | "med" | "low" = "med") =>
  ({ sessionId, scope: "", observedAt, refDate: null, priority, text });

describe("ObservationStore", () => {
  test("recent: undigested, newest first, one session left out", () => {
    const { db, s } = store();
    s.add(note("a", T0, "first"));
    s.add(note("b", T0 + DAY, "second"));
    s.add(note("now", T0 + 2 * DAY, "current conversation"));
    expect(s.recent("", { excludeSessionId: "now" }).map((n) => n.text)).toEqual(["second", "first"]);
    db.close();
  });

  test("forSession: this conversation's latest notes, oldest first", () => {
    const { db, s } = store();
    for (let i = 0; i < 12; i++) s.add(note("a", T0 + i, `n${i}`));
    expect(s.forSession("a", 3).map((n) => n.text)).toEqual(["n9", "n10", "n11"]);
    db.close();
  });

  test("weekPeriod is Monday..Sunday", () => {
    expect(weekPeriod(T0)).toBe("2026-09-21..2026-09-27");
  });

  test("a digest stands for its week's notes", () => {
    const { db, s } = store();
    const a = s.add(note("a", T0, "bought tickets"));
    const b = s.add(note("a", T0 + DAY, "chose seats"));
    s.addDigest("", weekPeriod(T0), "Bought tickets and chose seats.", [a, b], T0 + 10 * DAY);
    expect(s.recent("")).toEqual([]);
    expect(s.digests("").map((d) => d.text)).toEqual(["Bought tickets and chose seats."]);
    expect(s.undigestedBefore("", T0 + 30 * DAY)).toEqual([]);
    db.close();
  });

  test("deleting a digested note drops the digest and returns the rest of the week", () => {
    const { db, s } = store();
    const a = s.add(note("a", T0, "secret thing"));
    const b = s.add(note("a", T0 + DAY, "chose seats"));
    s.addDigest("", weekPeriod(T0), "Secret thing; chose seats.", [a, b], T0 + 10 * DAY);
    expect(s.delete(a, "")?.text).toBe("secret thing");
    expect(s.digests("")).toEqual([]);
    expect(s.undigestedBefore("", T0 + 30 * DAY).map((n) => n.text)).toEqual(["chose seats"]);
    db.close();
  });

  test("deleteMatching needs every word, ignores case, never touches digests", () => {
    const { db, s } = store();
    s.add(note("a", T0, "Flight to Lisbon on 12 Oct"));
    s.add(note("a", T0, "Lisbon hotel booked"));
    s.addDigest("", "2026-09-14..2026-09-20", "Talked about Lisbon flight", [], T0);
    expect(s.deleteMatching("", ["lisbon", "FLIGHT"]).map((n) => n.text)).toEqual(["Flight to Lisbon on 12 Oct"]);
    expect(s.list("").map((n) => n.text).sort()).toEqual(["Lisbon hotel booked", "Talked about Lisbon flight"]);
    db.close();
  });

  test("delete refuses another scope's note", () => {
    const { db, s } = store();
    const id = s.add({ ...note("discord:r:u", T0, "guest note"), scope: "discord/u" });
    expect(s.delete(id, "")).toBeNull();
    expect(s.count("discord/u")).toBe(1);
    db.close();
  });

  test("card: set, read, drop", () => {
    const { db, s } = store();
    expect(s.card("")).toBeNull();
    s.setCard("", "Darius builds Cinderpaw.", T0);
    expect(s.card("")).toEqual({ text: "Darius builds Cinderpaw.", updatedAt: T0 });
    s.dropCard("");
    expect(s.card("")).toBeNull();
    db.close();
  });
});

describe("importLegacyNotes", () => {
  test("moves [obs:] rows out of episodic once, scoped like facts", () => {
    const db = openDatabase(":memory:");
    const ep = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    ep.record("desk", "user", "hello");
    ep.record("desk", "assistant", "[obs:decision] Picked Postgres\n  • cheaper at scale\n  concepts: db");
    ep.record("discord:room:42", "assistant", "[obs:preference] Likes tea");
    expect(importLegacyNotes(db.raw)).toBe(2);
    expect(importLegacyNotes(db.raw)).toBe(0);
    const s = new ObservationStore(db.raw);
    expect(s.list("").map((n) => [n.text, n.source, n.priority])).toEqual([["Picked Postgres: cheaper at scale", "import", "low"]]);
    expect(s.count("discord/42")).toBe(1);
    expect(ep.recent("desk", 10).map((e) => e.content)).toEqual(["hello"]);
    db.close();
  });

  test("legacyNoteText keeps the title and bullet facts, drops concepts", () => {
    expect(legacyNoteText("[obs:task] Fix login\n  • token expired\n  • renew weekly\n  concepts: auth"))
      .toBe("Fix login: token expired; renew weekly");
    expect(legacyNoteText("[obs:change] Renamed repo")).toBe("Renamed repo");
  });
});
