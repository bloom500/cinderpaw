/**
 * The imagination: learning what an action does from actions already spent,
 * so the next one can be rehearsed for free.
 *
 * The load-bearing property is that NOTHING here touches an environment. Under
 * `(human/ai)^2`, an agent that presses buttons to learn the rules can
 * understand a game perfectly and still score 30, so learning has to happen
 * from history and prediction from a compiled transform.
 */

import { describe, expect, test } from "bun:test";
import {
  imagine,
  learnActionRules,
  recordOutcome,
  type ActionHistory,
} from "../src/arc/imagination.ts";

/** A 3x3 grid whose rows are the given values, for legible fixtures. */
const g = (...rows: number[][]) => rows;

describe("recordOutcome — history is append-only and never shared", () => {
  test("a new action starts its own entry", () => {
    const h = recordOutcome([], "ACTION1", g([1, 0]), g([0, 1]));
    expect(h).toHaveLength(1);
    expect(h[0]?.action).toBe("ACTION1");
    expect(h[0]?.pairs).toHaveLength(1);
  });

  test("the same action accumulates pairs", () => {
    let h: ActionHistory[] = recordOutcome([], "ACTION1", g([1, 0]), g([0, 1]));
    h = recordOutcome(h, "ACTION1", g([2, 0]), g([0, 2]));
    expect(h[0]?.pairs).toHaveLength(2);
  });

  test("the previous history is not mutated", () => {
    // A policy that mutates its own memory mid-turn cannot be replayed, and a
    // run nobody can replay is not evidence.
    const first = recordOutcome([], "ACTION1", g([1, 0]), g([0, 1]));
    const second = recordOutcome(first, "ACTION1", g([2, 0]), g([0, 2]));
    expect(first[0]?.pairs).toHaveLength(1);
    expect(second[0]?.pairs).toHaveLength(2);
    expect(first[0]?.pairs).not.toBe(second[0]?.pairs);
  });
});

describe("learnActionRules — a rule, or an honest nothing", () => {
  test("learns a transform an action reliably performs", async () => {
    // ACTION1 flips the grid upside-down, shown twice.
    const history: ActionHistory[] = [
      {
        action: "ACTION1",
        pairs: [
          { input: g([1, 2], [3, 4]), output: g([3, 4], [1, 2]) },
          { input: g([5, 6], [7, 8]), output: g([7, 8], [5, 6]) },
        ],
      },
    ];
    const rules = await learnActionRules(history, { iterations: 60 });
    const rule = rules.find((r) => r.action === "ACTION1");
    expect(rule).toBeDefined();
    expect(rule!.pairsSeen).toBe(2);
    expect(rule!.confidence).toBeGreaterThan(0);
  }, 30_000);

  test("an action with no observations yields no rule", async () => {
    // Nothing to generalise from; inventing one would be telemetry theatre.
    expect(await learnActionRules([{ action: "ACTION2", pairs: [] }])).toEqual([]);
  });

  test("confidence is measured against every pair, not taken on trust", async () => {
    // Two pairs that contradict each other: no single transform explains both,
    // so whatever is found must NOT come back claiming 1.0.
    const history: ActionHistory[] = [
      {
        action: "ACTION3",
        pairs: [
          { input: g([1, 2], [3, 4]), output: g([2, 1], [4, 3]) },
          { input: g([1, 2], [3, 4]), output: g([9, 9], [9, 9]) },
        ],
      },
    ];
    const rules = await learnActionRules(history, { iterations: 40 });
    for (const r of rules) expect(r.confidence).toBeLessThan(1);
  }, 30_000);

  test("a search that cannot run is a missing rule, not a crashed turn", async () => {
    // Ragged grids are invalid input to the verifier. The agent must keep
    // playing with whatever else it knows.
    const history = [
      { action: "ACTION4", pairs: [{ input: [[1, 2], [3]], output: [[1]] }] },
    ] as unknown as ActionHistory[];
    expect(await learnActionRules(history, { iterations: 10 })).toEqual([]);
  }, 30_000);
});

describe("imagine — rehearsal is free and refuses to guess", () => {
  test("returns null for an action it has no rule for", () => {
    expect(imagine([], "ACTION1", g([1, 2]))).toBeNull();
  });

  test("applies the learned program without touching an environment", () => {
    // 'horizontal' reverses ROW order in this DSL (flip upside-down), not
    // columns — the axis names the mirror line, not the direction of travel.
    const rules = [
      { action: "ACTION1", programCode: "(g) => mirror(g, 'horizontal')", confidence: 1, pairsSeen: 2 },
    ];
    expect(imagine(rules, "ACTION1", g([1, 2], [3, 4]))).toEqual(g([3, 4], [1, 2]));
  });

  test("a program that throws on this grid predicts nothing rather than crashing", () => {
    const rules = [
      { action: "ACTION1", programCode: "(g) => rotate(g, 45)", confidence: 1, pairsSeen: 1 },
    ];
    expect(imagine(rules, "ACTION1", g([1, 2], [3, 4]))).toBeNull();
  });

  test("an uncompilable rule predicts nothing", () => {
    const rules = [{ action: "ACTION1", programCode: "(g => broken", confidence: 1, pairsSeen: 1 }];
    expect(imagine(rules, "ACTION1", g([1]))).toBeNull();
  });
});
