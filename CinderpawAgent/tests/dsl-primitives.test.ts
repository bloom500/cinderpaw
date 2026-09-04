/**
 * dsl-primitives.test.ts — pure grid DSL (spec §Module 2).
 *
 * Properties over hand-written examples: rotation/mirror cycles close on
 * the identity, gravity is idempotent, flood fill terminates on same-color
 * input, crop of the full bbox is the identity — and NO primitive ever
 * mutates its input grid.
 */

import { describe, expect, test } from "bun:test";
import {
  applyGravity,
  crop,
  floodFill,
  mirror,
  recolor,
  replaceColor,
  rotate,
  selectByColor,
  selectLargest,
  selectSmallest,
  shift,
} from "../src/rlm/dsl/primitives.ts";
import { parseSceneGraph } from "../src/research/perception/scene-graph.ts";

const eq = (a: number[][], b: number[][]) => expect(a).toEqual(b);

/** Deep-freeze-style purity guard: run fn, assert the input bytes never moved. */
function pure<T>(grid: number[][], fn: (g: number[][]) => T, ...rest: unknown[]): T {
  const snapshot = JSON.stringify(grid);
  const result = fn(grid, ...rest);
  expect(JSON.stringify(grid)).toBe(snapshot);
  return result;
}

describe("rotate", () => {
  test("4 × 90° = identity (property)", () => {
    const grid = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    let g = grid;
    for (let i = 0; i < 4; i++) g = rotate(g, 90);
    eq(g, grid);
  });

  test("90 + 270 = identity and 180 = two 90s", () => {
    const grid = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    eq(rotate(rotate(grid, 90), 270), grid);
    eq(rotate(rotate(grid, 90), 90), rotate(grid, 180));
  });

  test("90° clockwise moves top-right to bottom-right", () => {
    const grid = [
      [1, 2],
      [3, 4],
    ];
    eq(rotate(grid, 90), [
      [3, 1],
      [4, 2],
    ]);
  });

  test("dimensions swap for 90/270, stay for 180", () => {
    const grid = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(rotate(grid, 90)).toHaveLength(3);
    expect(rotate(grid, 90)[0]).toHaveLength(2);
    expect(rotate(grid, 180)).toHaveLength(2);
  });

  test("rejects non-quarter angles with a clear message", () => {
    const grid = [[1]];
    expect(() => rotate(grid, 45)).toThrow(/unsupported angle 45.*90, 180, or 270/);
    expect(() => rotate(grid, 360)).toThrow(/unsupported angle 360/);
  });

  test("is pure", () => {
    const grid = [
      [1, 2],
      [3, 4],
    ];
    pure(grid, (g) => rotate(g, 90));
  });
});

describe("mirror", () => {
  test("2 mirrors = identity on both axes (property)", () => {
    const grid = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    eq(mirror(mirror(grid, "horizontal"), "horizontal"), grid);
    eq(mirror(mirror(grid, "vertical"), "vertical"), grid);
  });

  test("horizontal axis flips row order; vertical axis flips column order", () => {
    const grid = [
      [1, 2],
      [3, 4],
    ];
    eq(mirror(grid, "horizontal"), [
      [3, 4],
      [1, 2],
    ]);
    eq(mirror(grid, "vertical"), [
      [2, 1],
      [4, 3],
    ]);
  });

  test("rejects a bad axis", () => {
    // @ts-expect-error — deliberately wrong input
    expect(() => mirror([[1]], "diagonal")).toThrow(/unsupported axis "diagonal"/);
  });

  test("is pure", () => {
    pure(
      [
        [1, 2],
        [3, 4],
      ],
      (g) => mirror(g, "vertical"),
    );
  });
});

describe("shift", () => {
  test("(0,0) is the identity; positive dx/dy move right/down", () => {
    const grid = [
      [7, 0],
      [0, 0],
    ];
    eq(shift(grid, 0, 0), grid);
    eq(shift(grid, 1, 0), [
      [0, 7],
      [0, 0],
    ]);
    eq(shift(grid, 0, 1), [
      [0, 0],
      [7, 0],
    ]);
  });

  test("content pushed off the frame is dropped; vacated cells take fill", () => {
    const grid = [
      [9, 9],
      [9, 9],
    ];
    eq(shift(grid, -1, 0, 5), [
      [9, 5],
      [9, 5],
    ]);
    eq(shift(grid, 2, 2), [
      [0, 0],
      [0, 0],
    ]);
  });

  test("rejects fractional dx / non-finite fill", () => {
    const grid = [[0]];
    expect(() => shift(grid, 0.5, 0)).toThrow(/dx must be an integer/);
    expect(() => shift(grid, 0, Number.NaN)).toThrow(/dy must be an integer/);
    expect(() => shift(grid, 0, 0, Number.POSITIVE_INFINITY)).toThrow(/fill must be a finite number/);
  });
});

describe("crop", () => {
  test("cropping the FULL bbox is the identity (property)", () => {
    const grids = [
      [[1]],
      [
        [1, 2],
        [3, 4],
      ],
      [
        [0, 0, 0, 0],
        [0, 1, 2, 0],
        [0, 3, 4, 0],
        [0, 0, 0, 0],
      ],
    ];
    for (const grid of grids) {
      eq(crop(grid, { x: 0, y: 0, width: grid[0].length, height: grid.length }), grid);
    }
  });

  test("partial crop takes rows y..y+h and cols x..x+w", () => {
    const grid = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    eq(crop(grid, { x: 1, y: 1, width: 2, height: 2 }), [
      [5, 6],
      [8, 9],
    ]);
  });

  test("out-of-bounds bbox throws with bounds in the message", () => {
    const grid = [
      [1, 2],
      [3, 4],
    ];
    expect(() => crop(grid, { x: 1, y: 0, width: 5, height: 1 })).toThrow(/exceeds grid bounds 2x2/);
    expect(() => crop(grid, { x: 0, y: 0, width: 0, height: 1 })).toThrow(/positive width and height/);
    expect(() => crop(grid, { x: 0.5, y: 0, width: 1, height: 1 })).toThrow(/must all be integers/);
  });
});

describe("floodFill", () => {
  test("same-color fill returns immediately, unchanged (no infinite loop)", () => {
    const grid = [
      [1, 1],
      [1, 1],
    ];
    eq(pure(grid, (g) => floodFill(g, 0, 0, 1)), grid);
  });

  test("fills the connected region, stopped by walls", () => {
    const grid = [
      [0, 0, 0],
      [0, 9, 9],
      [0, 9, 0],
    ];
    eq(floodFill(grid, 0, 0, 3), [
      [3, 3, 3],
      [3, 9, 9],
      [3, 9, 0],
    ]);
  });

  test("4-connectivity: a diagonal gap stops the fill", () => {
    const grid = [
      [0, 1],
      [1, 0],
    ];
    eq(floodFill(grid, 0, 0, 5), [
      [5, 1],
      [1, 0],
    ]);
  });

  test("out-of-bounds start throws", () => {
    expect(() => floodFill([[0]], 3, 0)).toThrow(/row 3 outside grid bounds 0\.\.0/);
    expect(() => floodFill([[0]], 0, -1)).toThrow(/col -1 outside grid bounds/);
  });
});

describe("applyGravity", () => {
  test("gravity is idempotent: applying twice == applying once (property)", () => {
    const grids = [
      [
        [0, 2, 0, 4],
        [1, 0, 0, 0],
        [0, 0, 3, 0],
      ],
      [[5, 0], [0, 6]],
    ];
    for (const grid of grids) {
      for (const dir of ["down", "up", "left", "right"] as const) {
        eq(applyGravity(applyGravity(grid, dir), dir), applyGravity(grid, dir));
      }
    }
  });

  test("down sinks cells per column preserving order", () => {
    const grid = [
      [1, 0, 3],
      [0, 2, 0],
      [4, 0, 0],
    ];
    eq(applyGravity(grid, "down"), [
      [0, 0, 0],
      [1, 0, 0],
      [4, 2, 3],
    ]);
  });

  test("up pulls to the top; left/right compact their rows", () => {
    const grid = [
      [0, 7, 0],
      [8, 0, 0],
    ];
    eq(applyGravity(grid, "up"), [
      [8, 7, 0],
      [0, 0, 0],
    ]);
    eq(applyGravity(grid, "left"), [
      [7, 0, 0],
      [8, 0, 0],
    ]);
    eq(applyGravity(grid, "right"), [
      [0, 0, 7],
      [0, 0, 8],
    ]);
  });

  test("rejects an invalid direction", () => {
    // @ts-expect-error — deliberately wrong input
    expect(() => applyGravity([[0]], "north-east")).toThrow(/unsupported direction "north-east"/);
  });
});

describe("recolor / replaceColor", () => {
  test("renames exactly the matching color; both names agree", () => {
    const grid = [
      [1, 2],
      [2, 1],
    ];
    eq(recolor(grid, 2, 9), [
      [1, 9],
      [9, 1],
    ]);
    eq(replaceColor(grid, 2, 9), recolor(grid, 2, 9));
  });

  test("recoloring to the SAME color is the identity", () => {
    const grid = [
      [3, 0],
      [0, 3],
    ];
    eq(recolor(grid, 3, 3), grid);
  });
});

describe("selectByColor / selectLargest / selectSmallest", () => {
  const scene = [
    [1, 1, 1, 0, 2],
    [0, 0, 0, 0, 0],
    [1, 0, 0, 0, 2],
  ];

  test("selectByColor keeps only that color's objects", () => {
    const ones = selectByColor(scene, 1);
    expect(ones).toHaveLength(2);
    expect(ones.every((o) => o.color === 1)).toBe(true);
    // The two 2-cells sit two rows apart — NOT connected, so two objects.
    expect(selectByColor(scene, 2)).toHaveLength(2);
    expect(selectByColor(scene, 99)).toHaveLength(0);
  });

  test("largest/smallest pick by pixel count; empty list throws", () => {
    const objects = parseSceneGraph(scene).objects;
    expect(selectLargest(objects).color).toBe(1);
    expect(selectSmallest(objects).pixels).toHaveLength(1);
    expect(() => selectLargest([])).toThrow(/empty object list/);
    expect(() => selectSmallest([])).toThrow(/empty object list/);
  });
});

describe("purity across every primitive", () => {
  test("no primitive mutates its input grid", () => {
    const grid = [
      [0, 2, 0, 4],
      [1, 0, 0, 0],
      [0, 0, 3, 0],
    ];
    const snapshot = JSON.stringify(grid);
    rotate(grid, 90);
    rotate(grid, 180);
    rotate(grid, 270);
    mirror(grid, "horizontal");
    mirror(grid, "vertical");
    shift(grid, 1, 1, 7);
    crop(grid, { x: 0, y: 0, width: 2, height: 2 });
    floodFill(grid, 0, 0, 9);
    applyGravity(grid, "down");
    recolor(grid, 1, 8);
    replaceColor(grid, 2, 8);
    selectByColor(grid, 1);
    expect(JSON.stringify(grid)).toBe(snapshot);
  });
});
