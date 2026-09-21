/**
 * The per-turn drawers (task list, notebook, recall) are appended INSIDE the
 * user turn for prompt-cache stability. Two things went wrong with that on
 * 20 Sep, both on a plain "Saluuuuut":
 *   - the model read the block as text the user had pasted, called it an
 *     injection and refused to trust its own memory;
 *   - a month-old `in_progress` todo arrived as a standing order, and the
 *     greeting came back as ten tool calls resuming that task.
 * These pin the two lines of prompt that stop both.
 */
import { describe, expect, test } from "bun:test";
import { WorkingMemory } from "../src/memory/working.ts";

describe("runtime context inside the user turn", () => {
  test("is labelled as the runtime's, and closed, so it cannot pass for the user's paste", () => {
    const memory = new WorkingMemory("SYSTEM");
    memory.addUser("Saluuuuut");
    memory.setTodoList([{ id: "old", content: "a task from last month", status: "in_progress" }]);
    const lastUser = memory.render().at(-1)!.content;
    const [userText, rest] = lastUser.split("\n\n---\n\n");
    expect(userText).toBe("Saluuuuut");
    expect(rest).toMatch(/^\[Runtime context — appended by Cinderpaw's runtime .*not written by the user/);
    expect(rest!.trimEnd().endsWith("[End runtime context]")).toBe(true);
  });

  test("an open task list is reference, not an agenda", () => {
    const memory = new WorkingMemory("SYSTEM");
    memory.addUser("Saluuuuut");
    memory.setTodoList([{ id: "old", content: "a task from last month", status: "in_progress" }]);
    const lastUser = memory.render().at(-1)!.content;
    expect(lastUser).toContain("They are reference, not an agenda");
    expect(lastUser).toContain("A greeting, a question, or an unrelated task gets answered as itself");
  });

  test("no drawers, no label: the user turn is left exactly as typed", () => {
    const memory = new WorkingMemory("SYSTEM");
    memory.addUser("Saluuuuut");
    expect(memory.render().at(-1)!.content).toBe("Saluuuuut");
  });
});
