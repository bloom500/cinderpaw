/**
 * The model-driven inner policy.
 *
 * The cases that matter are the parsing ones: a reply the parser reads wrongly
 * spends a real action on the wrong button, and that failure is invisible in
 * the final score — it looks like the model played badly.
 */

import { describe, expect, test } from "bun:test";
import { createModelPolicy, parseChoice, renderGrid } from "../src/arc/model-policy.ts";
import { playLevel } from "../src/arc/play-level.ts";
import type { ArcEnvironment } from "../src/arc/environment.ts";

const ctx = (actions: string[], over: Partial<{ remaining: number; taken: string[] }> = {}) => ({
  actions,
  remaining: over.remaining ?? 10,
  taken: over.taken ?? [],
});

describe("parseChoice — the reply is the action, and getting it wrong costs a press", () => {
  test("takes the LAST named button, because models commit at the end", () => {
    const reply = "ACTION1 would hit the wall, and ACTION2 goes nowhere. I press ACTION3.";
    expect(parseChoice(reply, ["ACTION1", "ACTION2", "ACTION3"])).toBe("ACTION3");
  });

  test("a button that was not offered can never be chosen", () => {
    expect(parseChoice("I press ACTION5", ["ACTION1", "ACTION2"])).toBeNull();
  });

  test("coordinates come along when the model gives them", () => {
    expect(parseChoice("ACTION6:12,30", ["ACTION6"])).toBe("ACTION6:12,30");
    expect(parseChoice("I press ACTION6 12, 30", ["ACTION6"])).toBe("ACTION6:12,30");
  });

  test("ACTION1 is not found inside ACTION12", () => {
    // Word boundaries, not substring matching. The same class of bug the
    // tool-intent module documents: "dysfunction" matching "function".
    expect(parseChoice("press ACTION12", ["ACTION1"])).toBeNull();
  });

  test("an empty or non-string reply is null, not a crash", () => {
    expect(parseChoice("", ["ACTION1"])).toBeNull();
    expect(parseChoice(undefined as unknown as string, ["ACTION1"])).toBeNull();
  });
});

describe("renderGrid — compact enough to send every turn", () => {
  test("one hex character per cell, one line per row", () => {
    expect(renderGrid([[0, 1, 15], [10, 3, 3]])).toBe("01f\na33");
  });

  test("an empty grid says so rather than rendering nothing", () => {
    expect(renderGrid([])).toBe("(empty)");
  });

  test("a 64x64 grid is 64 lines, not a JSON blob", () => {
    const grid = Array.from({ length: 64 }, () => new Array(64).fill(7));
    const rendered = renderGrid(grid);
    expect(rendered.split("\n")).toHaveLength(64);
    // Measured: 4,159 characters against 8,321 for the JSON — half, every turn.
    expect(rendered.length).toBeLessThan(JSON.stringify(grid).length / 2);
  });
});

describe("createModelPolicy — what it sends and what it does with the answer", () => {
  test("the prompt carries the grid, the offered buttons and the budget", async () => {
    let sent = "";
    const policy = createModelPolicy({
      complete: async (messages) => {
        sent = messages.map((m) => m.content).join("\n");
        return "ACTION2";
      },
    });
    const choice = await policy({ grid: [[1, 2]], state: "NOT_FINISHED" }, ctx(["ACTION1", "ACTION2"], { remaining: 7 }));
    expect(choice).toBe("ACTION2");
    expect(sent).toContain("12");
    expect(sent).toContain("ACTION1, ACTION2");
    expect(sent).toContain("Presses remaining: 7");
  });

  test("the prompt never mentions ARC or the puzzle family", async () => {
    // The campaign rule: a change must be good natively, not a benchmark
    // trick. If this ever fails, someone has tuned the prompt to ARC and the
    // score stops meaning anything about the agent.
    let sent = "";
    const policy = createModelPolicy({
      complete: async (messages) => {
        sent = messages.map((m) => m.content).join("\n").toLowerCase();
        return "ACTION1";
      },
    });
    await policy({ grid: [[0]], state: "NOT_FINISHED" }, ctx(["ACTION1"]));
    for (const banned of ["arc", "puzzle", "abstraction", "reasoning corpus", "benchmark"]) {
      expect(sent).not.toContain(banned);
    }
  });

  test("an unparseable reply still presses something, and says so", async () => {
    const unparsed: string[] = [];
    const policy = createModelPolicy({
      complete: async () => "I am not sure what to do here.",
      onUnparsed: (reply) => unparsed.push(reply),
    });
    const choice = await policy({ grid: [[0]], state: "NOT_FINISHED" }, ctx(["ACTION3", "ACTION4"]));
    // Conceding scores zero for the level, so an arbitrary offered action is
    // strictly better than stopping.
    expect(choice).toBe("ACTION3");
    expect(unparsed).toHaveLength(1);
  });

  test("no available buttons is a voluntary stop, not a guess", async () => {
    const policy = createModelPolicy({ complete: async () => "ACTION1" });
    expect(await policy({ grid: [[0]], state: "NOT_FINISHED" }, ctx([]))).toBeNull();
  });

  test("it drives playLevel end to end", async () => {
    let at = 0;
    const env: ArcEnvironment = {
      actions: ["ACTION1", "ACTION2"],
      observe: () => ({ grid: [[at]], state: at >= 3 ? "WIN" : "NOT_FINISHED" }),
      act: () => {
        at++;
        return { grid: [[at]], state: at >= 3 ? "WIN" : "NOT_FINISHED" };
      },
    };
    const result = await playLevel({
      env,
      policy: createModelPolicy({ complete: async () => "ACTION2" }),
      maxActions: 10,
    });
    expect(result.state).toBe("WIN");
    expect(result.actions).toEqual(["ACTION2", "ACTION2", "ACTION2"]);
  });
});
