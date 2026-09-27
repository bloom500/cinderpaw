import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { MemoryExtractor, parseNotes, unobserved, observerTranscript } from "../src/memory/extractor.ts";
import { ObservationStore } from "../src/memory/observations.ts";
import type { ChatMessage, InferenceRouter } from "../src/types.ts";

const NOW = Date.UTC(2026, 8, 27, 9); // Sunday 27 Sep 2026
const ex = (u: string, a: string): ChatMessage[] => [
  { role: "user", content: u },
  { role: "assistant", content: a },
];

function rig(reply: string | (() => string)) {
  const prompts: { system: string; user: string }[] = [];
  const router = {
    complete: async (req: { messages: ChatMessage[] }) => {
      prompts.push({ system: req.messages[0]!.content, user: req.messages.at(-1)!.content });
      return { content: typeof reply === "function" ? reply() : reply };
    },
    evictSession: () => {},
  } as unknown as InferenceRouter;
  const db = openDatabase(":memory:");
  const notes = new ObservationStore(db.raw);
  const extractor = new MemoryExtractor(router, new SemanticMemory(db.raw, () => {}));
  extractor.setObservationStore(notes, { now: () => NOW, quietMs: 20 });
  // Not idle by default, so nothing runs behind the test's back: `drain` does
  // the work, deterministically. The quiet-flush test turns idle on.
  let idle = false;
  extractor.setIdleChecker(() => idle);
  return { db, notes, extractor, prompts, setIdle: (v: boolean) => (idle = v) };
}

describe("parseNotes", () => {
  test("priority | date | note, bad lines dropped", () => {
    expect(parseNotes("high | 2026-10-12 | Flight to Lisbon\nnonsense\nlow | - | Likes tea")).toEqual([
      { priority: "high", refDate: "2026-10-12", text: "Flight to Lisbon" },
      { priority: "low", refDate: null, text: "Likes tea" },
    ]);
  });
  test("keeps pipes inside the note", () => {
    expect(parseNotes("med | 2026-10 | buget | 800 EUR")[0]!.text).toBe("buget | 800 EUR");
  });
  test("a bullet marker and 'medium' are accepted", () => {
    expect(parseNotes("- medium | - | x")).toEqual([{ priority: "med", refDate: null, text: "x" }]);
  });
});

describe("unobserved", () => {
  const conv = [...ex("a", "A"), ...ex("b", "B"), ...ex("c", "C"), ...ex("d", "D")];
  test("everything after the last observed exchange", () => {
    expect(unobserved(conv, { user: "b", answer: "B" }).map((m) => m.content)).toEqual(["c", "C", "d", "D"]);
  });
  test("mark not found (compacted away): the last three exchanges", () => {
    expect(unobserved(conv, { user: "zzz", answer: "Z" })).toHaveLength(6);
  });
});

describe("observerTranscript", () => {
  test("user 4000 chars, answer 1500 chars, newest kept under 12000", () => {
    const t = observerTranscript([
      { role: "user", content: "u".repeat(5000) },
      { role: "assistant", content: "a".repeat(3000) },
    ]);
    expect(t).toContain("u".repeat(4000));
    expect(t).not.toContain("u".repeat(4001));
    expect(t).toContain("a".repeat(1500));
    expect(t).not.toContain("a".repeat(1501));
  });
});

describe("MemoryExtractor as Observer", () => {
  test("writes dated notes to the store, scoped like facts", async () => {
    const { db, notes, extractor } = rig("=== FACTS ===\nNONE\n=== NOTES ===\nhigh | 2026-10-12 | Flight to Lisbon, 800 EUR");
    extractor.extractAsync("desk", ex("I booked Lisbon for 12 Oct, 800 EUR", "Noted."));
    await extractor.drain(2000);
    expect(notes.list("").map((n) => [n.priority, n.refDate, n.text, n.observedAt])).toEqual([
      ["high", "2026-10-12", "Flight to Lisbon, 800 EUR", NOW],
    ]);
    expect(extractor.health.failures).toBe(0);
    expect(extractor.health.lastOkAt).toBe(NOW);
    db.close();
  });

  test("prompt names today and weekday, and reads whole messages", async () => {
    const { db, extractor, prompts } = rig("=== FACTS ===\nNONE\n=== NOTES ===\nNONE");
    extractor.extractAsync("desk", ex(`vinerea viitoare ${"x".repeat(1000)}`, "ok"));
    await extractor.drain(2000);
    expect(prompts[0]!.system).toContain("2026-09-27 (Sunday)");
    expect(prompts[0]!.user).toContain("x".repeat(1000));
    db.close();
  });

  test("drain at shutdown observes a second exchange the cadence skipped", async () => {
    const { db, extractor, prompts } = rig("=== FACTS ===\nNONE\n=== NOTES ===\nNONE");
    extractor.extractAsync("desk", ex("one", "1"));
    await extractor.drain(2000);
    extractor.extractAsync("desk", [...ex("one", "1"), ...ex("two", "2")]);
    await extractor.drain(2000);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.user).toContain("user: two");
    expect(prompts[1]!.user).not.toContain("user: one");
    db.close();
  });

  test("a quiet conversation is observed without a shutdown", async () => {
    const { db, extractor, prompts, setIdle } = rig("=== FACTS ===\nNONE\n=== NOTES ===\nNONE");
    setIdle(true);
    extractor.extractAsync("desk", ex("one", "1"));
    extractor.extractAsync("desk", [...ex("one", "1"), ...ex("two", "2")]);
    await new Promise((r) => setTimeout(r, 120));
    expect(prompts.some((p) => p.user.includes("user: two"))).toBe(true);
    db.close();
  });

  test("the notes already written reach the prompt, so it does not repeat itself", async () => {
    const { db, notes, extractor, prompts } = rig("=== FACTS ===\nNONE\n=== NOTES ===\nNONE");
    notes.add({ sessionId: "desk", scope: "", observedAt: NOW - 1000, refDate: null, priority: "med", text: "Earlier note" });
    extractor.extractAsync("desk", ex("hi", "hello"));
    await extractor.drain(2000);
    expect(prompts[0]!.user).toContain("- Earlier note");
    db.close();
  });

  test("an unreadable NOTES section is a counted failure with a reason", async () => {
    const { db, extractor } = rig("=== FACTS ===\nNONE\n=== NOTES ===\nI think the user likes things.");
    extractor.extractAsync("desk", ex("hi", "hello"));
    await extractor.drain(2000);
    expect(extractor.health.failures).toBe(1);
    expect(extractor.health.lastError).toContain("format");
    db.close();
  });

  test("a guest's notes are stored under the guest's scope", async () => {
    const { db, notes, extractor } = rig("=== FACTS ===\nNONE\n=== NOTES ===\nlow | - | Guest likes jazz");
    extractor.extractAsync("discord:room:77", ex("I like jazz", "Nice."));
    await extractor.drain(2000);
    expect(notes.count("")).toBe(0);
    expect(notes.count("discord/77")).toBe(1);
    db.close();
  });
});
