/**
 * A bare ACTION6 is a 500 from the server, and the policy is not the only
 * caller that can produce one — the frugal veto substitutes from
 * `available_actions`, which lists bare names. This covers the seam that every
 * press passes through.
 */
import { describe, expect, test } from "bun:test";
import { withClickTarget, biggestObjectCentre, centreOf, clickCandidates } from "../src/arc/click-target.ts";
import { renderClickCandidates } from "../src/arc/model-policy.ts";

const blank = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];
const withBlob = [
  [0, 0, 0, 0],
  [0, 5, 5, 0],
  [0, 5, 5, 0],
  [0, 0, 0, 0],
];

describe("withClickTarget", () => {
  test("a bare ACTION6 gets coordinates", () => {
    expect(withClickTarget("ACTION6", withBlob)).toMatch(/^ACTION6:\d+,\d+$/);
  });

  test("an ACTION6 that already has coordinates is left alone", () => {
    expect(withClickTarget("ACTION6:12,30", withBlob)).toBe("ACTION6:12,30");
  });

  test("every other action passes through untouched", () => {
    expect(withClickTarget("ACTION1", withBlob)).toBe("ACTION1");
  });

  test("an empty board still produces a press, at the centre", () => {
    expect(biggestObjectCentre(blank)).toBeNull();
    expect(withClickTarget("ACTION6", blank)).toBe(`ACTION6:${centreOf(blank).x},${centreOf(blank).y}`);
  });

  test("the point lands on the object, in server order (x is the column)", () => {
    const p = biggestObjectCentre(withBlob);
    expect(p).not.toBeNull();
    expect(withBlob[p.y][p.x]).toBe(5);
  });
});

/**
 * The candidate shortlist. This exists because the measurement that motivated it
 * is unambiguous: GLM 5.3 Flash spent 14-45 tokens choosing between named
 * buttons and 27,163 / 31,557 choosing an x,y on the same grid, at reasoning
 * effort medium and low respectively. What is tested here is not the token
 * saving — that needs a model — but the two things that would silently ruin the
 * shortlist: getting x and y the wrong way round, and quietly turning a
 * shortlist into an answer.
 */
describe("clickCandidates", () => {
  /** Two objects of different sizes, at known and DIFFERENT row/column pairs. */
  const board = (): number[][] => {
    const g = Array.from({ length: 12 }, () => Array(12).fill(0));
    // 3 wide x 2 tall at rows 1-2, columns 6-8. Deliberately not square and
    // deliberately off-diagonal: a transposed centre lands outside it.
    for (const r of [1, 2]) for (const c of [6, 7, 8]) g[r][c] = 4;
    g[9][1] = 7; // a single cell, so "biggest first" has something to order
    return g;
  };

  test("every centre lands on its own object, with x as the column", () => {
    const g = board();
    const found = clickCandidates(g);
    expect(found.length).toBe(2);
    for (const c of found) {
      // The one assertion that catches a transposition: index rows by y and
      // columns by x, and the cell must be the object's own colour.
      expect(g[c.y][c.x]).toBe(c.colour);
    }
  });

  test("biggest first, and the biggest is what the fallback would have picked", () => {
    const g = board();
    const found = clickCandidates(g);
    expect(found[0].cells).toBe(6);
    expect(found[1].cells).toBe(1);
    expect({ x: found[0].x, y: found[0].y }).toEqual(biggestObjectCentre(g));
  });

  test("max is honoured, so the prompt cannot be flooded by a busy grid", () => {
    const g = Array.from({ length: 20 }, () => Array(20).fill(0));
    for (let i = 0; i < 20; i += 2) g[i][i] = 3; // ten separate specks
    expect(clickCandidates(g, 3).length).toBe(3);
  });

  test("an empty board offers nothing rather than inventing a target", () => {
    expect(clickCandidates(Array.from({ length: 6 }, () => Array(6).fill(0)))).toEqual([]);
  });

  test("the rendered block offers candidates without claiming they are the answer", () => {
    const text = renderClickCandidates(board());
    expect(text).not.toBeNull();
    // It must say these are objects, not clickable squares, and it must leave
    // the rest of the board open — otherwise the score measures parseSceneGraph
    // and the model is a rubber stamp.
    expect(text).toContain("NOT a list of what is clickable");
    expect(text).toContain("including one that is not listed");
    // columns 6-8 -> x = floor(6 + 3/2) = 7;  rows 1-2 -> y = floor(1 + 2/2) = 2
    expect(text).toContain("centre (7,2)");
  });

  test("nothing to describe means no block at all, not an empty heading", () => {
    expect(renderClickCandidates(Array.from({ length: 6 }, () => Array(6).fill(0)))).toBeNull();
  });
});
