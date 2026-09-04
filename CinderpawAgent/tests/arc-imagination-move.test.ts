/**
 * The move learner, held to the two things that would make it dangerous:
 * a rule invented from a board it does not understand, and an "I don't know"
 * reported as "that press does nothing".
 */
import { describe, expect, test } from "bun:test";
import {
  learnMoveRules,
  moveBetween,
  applyMove,
  imagineMove,
} from "../src/arc/imagination-move.ts";

/** floor 3, a 2x1 sprite of colour 9 at (x,y), frame of colour 4 down column 0. */
function board(x: number, y: number, extra: [number, number, number][] = []): number[][] {
  const g = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 3));
  for (let r = 0; r < 8; r++) g[r]![0] = 4;
  g[y]![x] = 9;
  g[y + 1]![x] = 9;
  for (const [ex, ey, c] of extra) g[ey]![ex] = c;
  return g;
}

describe("moveBetween", () => {
  test("reads the offset, the colours and the floor off one press", () => {
    const m = moveBetween(board(4, 4), board(4, 2));
    expect(m).not.toBeNull();
    expect({ dx: m!.dx, dy: m!.dy, colours: m!.colours, leaves: m!.leaves }).toEqual({
      dx: 0,
      dy: -2,
      colours: [9],
      leaves: 3,
    });
  });

  test("a counter ticking over does not veto the reading", () => {
    // Two unrelated cells change colour as well — the scoreboard. Measured on a
    // real game: 50 cells of sprite, 2 cells of counter, every press.
    const after = board(4, 2, [[6, 7, 8]]);
    const m = moveBetween(board(4, 4, [[6, 7, 11]]), after);
    expect(m?.dy).toBe(-2);
  });

  test("two things moving different ways is no rule at all", () => {
    const before = board(4, 4, [[6, 1, 9]]);
    const after = board(4, 2, [[6, 5, 9]]);
    expect(moveBetween(before, after)).toBeNull();
  });

  test("a board that did not move gives nothing", () => {
    expect(moveBetween(board(4, 4), board(4, 4))).toBeNull();
  });
});

describe("learnMoveRules", () => {
  test("presses that changed nothing count against the rule, not out of it", () => {
    const rules = learnMoveRules([
      {
        action: "ACTION1",
        pairs: [
          { input: board(4, 4), output: board(4, 2) },
          { input: board(4, 2), output: board(4, 2) }, // blocked
        ],
      },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.confidence).toBe(0.5);
    expect(rules[0]!.blockedSeen).toBe(1);
  });

  test("one press that disagrees destroys the rule", () => {
    const rules = learnMoveRules([
      {
        action: "ACTION1",
        pairs: [
          { input: board(4, 4), output: board(4, 2) },
          { input: board(4, 4), output: board(6, 4) },
        ],
      },
    ]);
    expect(rules).toEqual([]);
  });
});

describe("applyMove — the contract that protects the score", () => {
  /** A rule as the learner would produce it: one press that moved, watched. */
  const learned = (pairs: { input: number[][]; output: number[][] }[]) =>
    learnMoveRules([{ action: "ACTION1", pairs }])[0]!;

  const walked = learned([{ input: board(4, 4), output: board(4, 2) }]);

  test("a free square moves the sprite", () => {
    expect(applyMove(board(4, 6), walked)).toEqual(board(4, 4));
  });

  test("the edge blocks, and needs no evidence to be believed", () => {
    const atTop = board(4, 0);
    expect(applyMove(atTop, walked)).toEqual(atTop);
  });

  test("a colour never seen ahead is UNKNOWN, not a wall", () => {
    // The old model called anything that was not floor a wall. Measured on ten
    // games, that turned two thirds of the working presses into "this does
    // nothing" — the prediction that talks the policy out of a press.
    const strange = board(4, 4, [
      [4, 3, 5],
      [5, 3, 5],
    ]);
    expect(applyMove(strange, walked)).toBeNull();
  });

  test("a colour watched stopping it twice IS a wall", () => {
    const wall = (x: number, y: number) => board(x, y, [[x, y - 1, 5], [x, y - 2, 5]]);
    const rule = learned([
      { input: board(4, 6), output: board(4, 4) },
      { input: wall(4, 4), output: wall(4, 4) },
      { input: wall(2, 4), output: wall(2, 4) },
    ]);
    expect(rule.blocking).toContain(5);
    expect(applyMove(wall(4, 4), rule)).toEqual(wall(4, 4));
  });

  test("a sprite it cannot pick out returns null, NOT the board", () => {
    // Two identical shapes the same distance away: which one is the player is
    // unknowable from this board. Returning the grid would read as "this press
    // does nothing" and talk the policy out of an action that works.
    const twins = board(4, 4, [
      [6, 4, 9],
      [6, 5, 9],
    ]);
    expect(applyMove(twins, { ...walked, lastAt: { x: 5, y: 4 } })).toBeNull();
    expect(imagineMove([{ ...walked, lastAt: { x: 5, y: 4 } }], "ACTION1", twins)).toBeNull();
  });
});
