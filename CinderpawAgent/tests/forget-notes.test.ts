import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { MemoryGraph } from "../src/memory/graph.ts";
import { ObservationStore } from "../src/memory/observations.ts";
import { forgetMirrors } from "../src/memory/forget.ts";
import { createRememberTool } from "../src/tools/builtin/remember.ts";

const T = Date.UTC(2026, 8, 20);

describe("forgetting reaches notes and the card", () => {
  test("remember forget_notes deletes matching notes and says which", async () => {
    const db = openDatabase(":memory:");
    const notes = new ObservationStore(db.raw);
    notes.add({ sessionId: "s", scope: "", observedAt: T, refDate: null, priority: "high", text: "Trip to Lisbon in October" });
    notes.add({ sessionId: "s", scope: "", observedAt: T, refDate: null, priority: "low", text: "Likes tea" });
    const tool = createRememberTool(new SemanticMemory(db.raw, () => {}), {
      onForgetNotes: (words, scope) => notes.deleteMatching(scope, words),
    });
    const r = await tool.execute({ key: "trip", forget_notes: "Lisbon" }, { sessionId: "desk" } as never);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Trip to Lisbon in October");
    expect(notes.list("").map((n) => n.text)).toEqual(["Likes tea"]);
    db.close();
  });

  test("forgetting a fact drops the card until the Reflector rewrites it", () => {
    const db = openDatabase(":memory:");
    const notes = new ObservationStore(db.raw);
    notes.setCard("", "Dates Ana.", T);
    const semantic = new SemanticMemory(db.raw, () => {});
    forgetMirrors({ graph: new MemoryGraph({ path: ":memory:" }), semantic, fractal: { forgetFact: () => [] }, notes }, "girlfriend");
    expect(notes.card("")).toBeNull();
    db.close();
  });
});
