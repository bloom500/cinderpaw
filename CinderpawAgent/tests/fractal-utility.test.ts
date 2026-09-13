/**
 * Utility-scored retrieval (plan §3.3, first slice): the ledger from task
 * outcome back to the leaves in context, and a scorer whose knob at 0 is
 * today's ranking exactly.
 */
import { describe, expect, test } from "bun:test";
import { UtilityLedger, rerankByUtility, utilityScore } from "../src/memory/fractal/utility.ts";

describe("UtilityLedger", () => {
  test("a closed success marks every leaf shown across the task's turns as helped, once each", () => {
    const l = new UtilityLedger();
    l.shown("t1", [1, 2]);
    l.shown("t1", [2, 3]); // second lookup on the same turn: 2 counted once
    l.shown("t2", [3, 4]);
    expect(l.closed(["t1", "t2"], true)).toBe(4);
    for (const id of [1, 2, 3, 4]) expect(l.stats(id)).toEqual({ present: 1, helped: 1 });
    expect(l.openTurns()).toEqual([]);
  });

  test("a failure counts presence and not help; an unknown leaf is neutral", () => {
    const l = new UtilityLedger();
    l.shown("t", [7]);
    l.closed(["t"], false);
    expect(l.stats(7)).toEqual({ present: 1, helped: 0 });
    expect(l.utility(7)).toBe(0.5);
    expect(l.utility(99)).toBe(1);
  });

  test("a turn never closed is not evidence and stays listed", () => {
    const l = new UtilityLedger();
    l.shown("orphan", [5]);
    expect(l.utility(5)).toBe(1);
    expect(l.openTurns().map((r) => r.turnId)).toEqual(["orphan"]);
  });

  test("round-trips through entries()", () => {
    const l = new UtilityLedger();
    l.shown("t", [1]);
    l.closed(["t"], true);
    const back = UtilityLedger.from(l.entries());
    expect(back.stats(1)).toEqual({ present: 1, helped: 1 });
  });
});

describe("rerankByUtility", () => {
  const hits = [
    { leafId: 1, score: 0.8 },
    { leafId: 2, score: 0.8 },
    { leafId: 3, score: 0.7 },
  ];

  test("at weight 0 the order and the scores are today's, byte for byte", () => {
    const l = new UtilityLedger();
    l.shown("t", [1]);
    l.closed(["t"], false);
    expect(rerankByUtility(hits, l, 0)).toEqual(hits);
    expect(utilityScore(0.8, 0.5, 0)).toBe(0.8);
  });

  test("two leaves of equal similarity: the one that helped ranks first; a never-shown leaf is not buried", () => {
    const l = new UtilityLedger();
    l.shown("a", [1]);
    l.closed(["a"], false); // leaf 1 shown once, did not help -> 0.5
    l.shown("b", [3]);
    l.shown("c", [3]);
    l.closed(["b"], true);
    l.closed(["c"], true); // leaf 3 helped twice -> 3/3 = 1
    const out = rerankByUtility(hits, l, 1);
    // leaf 2 (never shown, utility 1) keeps 0.8; leaf 1 drops to 0.4; leaf 3 stays 0.7.
    expect(out.map((h) => h.leafId)).toEqual([2, 3, 1]);
    expect(out[2]!.score).toBeCloseTo(0.4);
  });
});
