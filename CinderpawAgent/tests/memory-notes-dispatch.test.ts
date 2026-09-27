/**
 * The Memory page's view of observational memory: the card, the notes, and
 * whether writing them works. A stranger whose model cannot follow the note
 * format must be able to see that on screen, not in a log.
 */
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { ObservationStore } from "../src/memory/observations.ts";
import { memoryNotesReply } from "../src/dispatch.ts";

const health = { lastOkAt: 5, failures: 0, lastError: null };

describe("memory_notes", () => {
  test("list returns the card, the notes and both health lines", () => {
    const db = openDatabase(":memory:");
    const notes = new ObservationStore(db.raw);
    notes.setCard("", "Card.", 1);
    notes.add({ sessionId: "s", scope: "", observedAt: 2, refDate: "2026-10-12", priority: "high", text: "Trip" });
    const r = memoryNotesReply({ id: "q1", notesOp: "list" }, { notes, observer: health, reflector: health });
    expect(r).toMatchObject({ type: "memory_notes_result", id: "q1", ok: true, card: "Card." });
    expect(r.notes.map((n) => [n.text, n.refDate, n.priority])).toEqual([["Trip", "2026-10-12", "high"]]);
    expect(r.health.observer.lastOkAt).toBe(5);
    db.close();
  });

  test("delete removes one owner note and answers with the fresh list", () => {
    const db = openDatabase(":memory:");
    const notes = new ObservationStore(db.raw);
    const id = notes.add({ sessionId: "s", scope: "", observedAt: 2, refDate: null, priority: "low", text: "Gone" });
    const r = memoryNotesReply({ id: "q2", notesOp: "delete", noteId: id }, { notes, observer: health, reflector: health });
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([]);
    db.close();
  });

  test("deleting a note that does not exist says so", () => {
    const db = openDatabase(":memory:");
    const r = memoryNotesReply(
      { id: "q3", notesOp: "delete", noteId: 99 },
      { notes: new ObservationStore(db.raw), observer: health, reflector: health },
    );
    expect(r).toMatchObject({ ok: false, error: "That note no longer exists." });
    db.close();
  });

  test("a guest's notes are not on the owner's page", () => {
    const db = openDatabase(":memory:");
    const notes = new ObservationStore(db.raw);
    notes.add({ sessionId: "discord:r:7", scope: "discord/7", observedAt: 2, refDate: null, priority: "low", text: "Guest" });
    const r = memoryNotesReply({ id: "q4", notesOp: "list" }, { notes, observer: health, reflector: health });
    expect(r.notes).toEqual([]);
    db.close();
  });
});
