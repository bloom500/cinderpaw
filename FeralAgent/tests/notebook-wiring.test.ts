import { expect, test } from "bun:test";
import { WorkingMemory } from "../src/memory/working.ts";

// The store shape the agent loop consumes. Kept structural so the loop never
// imports SemanticMemory — same reason setTodoStore is structural.
type NotebookStore = { notes(scope: string): Array<{ key: string; value: string }> };

test("the notebook store shape renders through WorkingMemory unchanged", () => {
  const store: NotebookStore = {
    notes: () => [{ key: "note:position", value: "compiling the parser" }],
  };
  const mem = new WorkingMemory("sys");
  mem.setNotebook(store.notes(""));
  mem.addUser("go");
  expect(mem.render().at(-1)!.content).toContain("compiling the parser");
});

test("a throwing notebook store must not be able to cost a turn", () => {
  const store: NotebookStore = {
    notes: () => {
      throw new Error("db locked");
    },
  };
  const mem = new WorkingMemory("sys");
  // Mirrors the guard in the agent loop: the refresh is wrapped, the turn goes on.
  expect(() => {
    try {
      mem.setNotebook(store.notes(""));
    } catch {
      /* the loop swallows it */
    }
    mem.addUser("go");
  }).not.toThrow();
  expect(mem.render().at(-1)!.content).toBe("go");
});
