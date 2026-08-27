/**
 * A bare ACTION6 is a 500 from the server, and the policy is not the only
 * caller that can produce one — the frugal veto substitutes from
 * `available_actions`, which lists bare names. This covers the seam that every
 * press passes through.
 */
import { describe, expect, test } from "bun:test";
import { withClickTarget, biggestObjectCentre, centreOf } from "../src/arc/click-target.ts";

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
