/**
 * The agent is told where it is: local hour, operating system, and what it may
 * change. It used to know only the date, and found its permission mode by
 * being refused (29 Oct 2026).
 */
process.env.TZ = "Europe/Bucharest";
import { describe, expect, test } from "bun:test";
import { situation } from "../src/memory/day.ts";
import { WorkingMemory } from "../src/memory/working.ts";

// 29 Oct 2026, 00:30 in Bucharest = 22:30 the day before in London.
const LATE = Date.UTC(2026, 9, 28, 22, 30);

describe("the situation block", () => {
  test("says the local hour and day, the OS and the mode in the words the person sees", () => {
    const s = situation(LATE, "win32", "read_only");
    expect(s).toContain("Thursday 2026-10-29, 00:30 (Europe/Bucharest)");
    expect(s).toContain("runs Windows");
    expect(s).toContain("Look only");
    expect(s).toContain("Can edit files or Full access");
  });

  test("rides on the last user message, so the system prompt stays cacheable", () => {
    const m = new WorkingMemory("SYSTEM");
    m.addUser("hi");
    m.setSituation(situation(LATE, "darwin", "full_access"));
    const out = m.render();
    expect(out[0].content).toBe("SYSTEM");
    expect(String(out.at(-1)?.content)).toContain("## Right now");
    expect(String(out.at(-1)?.content)).toContain("runs macOS");
  });
});

import { contextLanes } from "../src/memory/working.ts";

describe("the Context card's lanes", () => {
  test("group the prompt the way a person reads it, biggest first", () => {
    const lanes = contextLanes({
      localTotal: 0,
      parts: [
        { category: "system_prompt", detail: "system_prompt", tokens: 6000 },
        { category: "tool_schemas", detail: "26 advertised", tokens: 4900 },
        { category: "conversation", detail: "user", tokens: 9000 },
        { category: "conversation", detail: "assistant", tokens: 3000 },
        { category: "drawer", detail: "skill_menu", tokens: 700 },
        { category: "drawer", detail: "memory_snapshot", tokens: 500 },
        { category: "drawer", detail: "situation", tokens: 60 },
        { category: "tool_output", detail: "read_file (full)", tokens: 2000 },
      ],
    });
    expect(lanes).toEqual([
      { label: "Messages", tokens: 12000 },
      { label: "Instructions", tokens: 6000 },
      { label: "Tools", tokens: 4900 },
      { label: "Tool results", tokens: 2000 },
      { label: "Skills", tokens: 700 },
      { label: "Memory", tokens: 500 },
      { label: "Notes and plan", tokens: 60 },
    ]);
  });
});
