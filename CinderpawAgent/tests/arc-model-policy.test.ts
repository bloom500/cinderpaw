/**
 * The model-driven inner policy.
 *
 * The cases that matter are the parsing ones: a reply the parser reads wrongly
 * spends a real action on the wrong button, and that failure is invisible in
 * the final score — it looks like the model played badly.
 */

import { describe, expect, test } from "bun:test";
import { createModelPolicy, parseChoice, renderGrid, renderScene } from "../src/arc/model-policy.ts";
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

/**
 * Perception in the prompt.
 *
 * The model used to get 4,159 characters of hex and nothing else, while the
 * DSL and the MCTS rehearsal both reason in objects. `renderScene` gives it the
 * same reading — and, more importantly, knows when not to.
 */
describe("renderScene — the grid, described", () => {
  test("names the objects it finds", () => {
    const grid = [
      [0, 0, 0, 0],
      [0, 3, 3, 0],
      [0, 3, 3, 0],
      [0, 0, 0, 5],
    ];
    const text = renderScene(grid);
    expect(text).toContain("scene: 4x4");
    expect(text).toContain("color: 3");
    expect(text).toContain("color: 5");
  });

  test("background is the most common colour, not hard-coded 0", () => {
    // A playfield of 8s with one object on it. Treating 0 as background would
    // make the whole board one object and describe nothing.
    const grid = [
      [8, 8, 8, 8],
      [8, 2, 8, 8],
      [8, 8, 8, 8],
      [8, 8, 8, 8],
    ];
    const text = renderScene(grid);
    expect(text).toContain("color: 2");
    expect(text).not.toContain("color: 8");
  });

  test("says nothing about an empty board", () => {
    expect(renderScene([[0, 0], [0, 0]])).toBeNull();
  });

  test("a scattered grid stays bounded instead of flooding the prompt", () => {
    // The real bad case, measured: this shape parses to 819 objects and
    // 346,205 relations. Parsing it costs 32ms — CPU was never the risk. The
    // risk is a description longer than the grid it describes, so the caps
    // bound the OUTPUT and the truncation is stated.
    const scattered = Array.from({ length: 64 }, (_, r) =>
      Array.from({ length: 64 }, (_, c) => ((r * 31 + c * 17) % 5 === 0 ? 3 : 0)),
    );
    const started = Date.now();
    const text = renderScene(scattered);
    expect(Date.now() - started).toBeLessThan(500);
    if (text !== null) {
      expect(text).toContain("objects in total");
      // Bounded well under the 4,159 characters the raw grid costs.
      expect(text.length).toBeLessThan(4000);
    }
  });

  test("a real frame is described, not skipped", () => {
    // ls20's opening frame measured 1,487 non-background cells. The first cap
    // was 1,200, which silently turned perception off for every game in the
    // benchmark — the cap was set by fear, and 6ms of measurement corrected it.
    const dense = Array.from({ length: 64 }, (_, r) =>
      Array.from({ length: 64 }, (_, c) => (r < 24 ? 4 : c % 3 === 0 ? 3 : 4)),
    );
    expect(renderScene(dense)).not.toBeNull();
  });

  test("truncates a long list and admits it, rather than omitting silently", () => {
    // 30 separated single cells, capped at 5.
    const grid = Array.from({ length: 30 }, (_, r) =>
      Array.from({ length: 3 }, (_, c) => (c === 1 && r % 2 === 0 ? 4 : 0)),
    );
    const text = renderScene(grid, { maxObjects: 5 });
    expect(text).toContain("objects in total");
    expect(text).toContain("the 5 largest are listed");
  });

  test("a malformed grid loses perception, never the turn", () => {
    expect(renderScene([])).toBeNull();
    expect(renderScene([[1, 2], [3]] as number[][])).toBeNull();
  });
});

/**
 * The bare ACTION6.
 *
 * ACTION6 is the only action that takes coordinates and it requires them. Sent
 * without, the server returns a 500 with an HTML error page — which reads as an
 * outage, and cost six games and a debugging session before the pattern showed
 * up: every single failure was ACTION6, never anything else.
 */
describe("createModelPolicy — ACTION6 always leaves with coordinates", () => {
  const board = () => {
    // A 12x12 board of 0s with one 3x3 block of 7s at columns 6-8, rows 2-4.
    const g = Array.from({ length: 12 }, () => Array.from({ length: 12 }, () => 0));
    for (let r = 2; r <= 4; r++) for (let c = 6; c <= 8; c++) g[r]![c] = 7;
    return g;
  };

  test("a reply naming ACTION6 alone gets a point, not a 500", async () => {
    const guesses: string[] = [];
    const policy = createModelPolicy({
      complete: async () => "ACTION6",
      onCoordinateGuess: (a) => guesses.push(a),
    });
    const chosen = await policy(
      { grid: board(), state: "NOT_FINISHED" },
      { actions: ["ACTION6"], remaining: 10, taken: [] },
    );
    expect(chosen).toMatch(/^ACTION6:\d+,\d+$/);
    expect(guesses).toEqual([chosen]);
  });

  test("the point is the middle of the biggest object, x=column y=row", async () => {
    const policy = createModelPolicy({ complete: async () => "ACTION6" });
    const chosen = await policy(
      { grid: board(), state: "NOT_FINISHED" },
      { actions: ["ACTION6"], remaining: 10, taken: [] },
    );
    // The block spans columns 6-8 and rows 2-4, so the centre is x=7, y=3.
    expect(chosen).toBe("ACTION6:7,3");
  });

  test("an empty board still yields a legal point rather than nothing", async () => {
    const policy = createModelPolicy({ complete: async () => "ACTION6" });
    const chosen = await policy(
      { grid: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 0)), state: "NOT_FINISHED" },
      { actions: ["ACTION6"], remaining: 10, taken: [] },
    );
    expect(chosen).toBe("ACTION6:4,4");
  });

  test("coordinates the model DID give are left alone", async () => {
    const policy = createModelPolicy({ complete: async () => "ACTION6:11,2" });
    const chosen = await policy(
      { grid: board(), state: "NOT_FINISHED" },
      { actions: ["ACTION6"], remaining: 10, taken: [] },
    );
    expect(chosen).toBe("ACTION6:11,2");
  });
});
