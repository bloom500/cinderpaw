/**
 * Projects (spec 9): a chat in a project carries the project's instructions
 * and files in the system prompt; any other chat carries nothing new.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAddendum, PROJECT_INSTRUCTIONS_MAX } from "../src/projects.ts";
import { WorkingMemory } from "../src/memory/working.ts";

const dirs: string[] = [];
function home(projects: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "cp-projects-"));
  dirs.push(d);
  writeFileSync(join(d, "projects.json"), JSON.stringify(projects));
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TRIP = {
  id: "p1",
  name: "Japan trip",
  conversation_ids: ["chat-1"],
  instructions: "Budget is 2000 EUR. Answer in Romanian.",
  files: [{ name: "flights.pdf", path: "C:/Users/x/.cinderpaw/workspace/projects/p1/flights.pdf" }],
};

describe("projectAddendum", () => {
  test("a chat in a project gets its name, instructions and file paths", () => {
    const text = projectAddendum("chat-1", home([TRIP]));
    expect(text).toContain("## Project: Japan trip");
    expect(text).toContain("Budget is 2000 EUR. Answer in Romanian.");
    expect(text).toContain("- flights.pdf: C:/Users/x/.cinderpaw/workspace/projects/p1/flights.pdf");
  });

  test("a chat in no project, or in one with nothing set, gets nothing", () => {
    expect(projectAddendum("chat-2", home([TRIP]))).toBe("");
    expect(projectAddendum("chat-1", home([{ ...TRIP, instructions: "", files: [] }]))).toBe("");
  });

  test("an old projects.json, a missing one or a broken one is a turn without project context", () => {
    expect(projectAddendum("chat-1", home([{ id: "p1", name: "Old", conversation_ids: ["chat-1"] }]))).toBe("");
    const empty = mkdtempSync(join(tmpdir(), "cp-projects-"));
    dirs.push(empty);
    expect(projectAddendum("chat-1", empty)).toBe("");
    const broken = home([]);
    writeFileSync(join(broken, "projects.json"), "{not json");
    expect(projectAddendum("chat-1", broken)).toBe("");
  });

  test("a pasted book is cut to the cap", () => {
    const text = projectAddendum("chat-1", home([{ ...TRIP, instructions: "x".repeat(PROJECT_INSTRUCTIONS_MAX + 500), files: [] }]));
    expect(text.length).toBeLessThan(PROJECT_INSTRUCTIONS_MAX + 200);
  });
});

describe("WorkingMemory.setProject", () => {
  test("the project rides the system prompt, and changes with it", () => {
    const m = new WorkingMemory("You are Cinderpaw.");
    m.addUser("hi");
    m.setProject("## Project: Japan trip");
    expect(m.render()[0]!.content).toBe("You are Cinderpaw.\n\n## Project: Japan trip");
    m.setProject("");
    expect(m.render()[0]!.content).toBe("You are Cinderpaw.");
  });
});
