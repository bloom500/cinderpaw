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
  const rule = { dx: 0, dy: -2, colours: [9], leaves: 3, size: 2 };

  test("a free square moves the sprite", () => {
    expect(applyMove(board(4, 4), rule)).toEqual(board(4, 2));
  });

  test("something in the way is reported as a press worth nothing", () => {
    const blocked = board(4, 4, [[4, 3, 5]]);
    expect(applyMove(blocked, rule)).toEqual(blocked);
  });

  test("the edge blocks too", () => {
    const atTop = board(4, 0);
    expect(applyMove(atTop, rule)).toEqual(atTop);
  });

  test("a sprite it cannot pick out returns null, NOT the board", () => {
    // Two groups of the right size: which one is the player is unknowable from
    // this board alone. Returning the grid would read as "this press does
    // nothing" and talk the policy out of an action that works.
    const twins = board(4, 4, [
      [6, 4, 9],
      [6, 5, 9],
    ]);
    expect(applyMove(twins, rule)).toBeNull();
    expect(imagineMove([{ action: "A", confidence: 1, pairsSeen: 1, blockedSeen: 0, ...rule }], "A", twins)).toBeNull();
  });
});
