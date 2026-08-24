/**
 * scene-graph.test.ts — Scene Graph Perception (spec §Module 1).
 *
 * Property checks + hand-written small-grid cases. Pins the documented
 * relation semantics so downstream consumers can rely on them.
 */

import { describe, expect, test } from "bun:test";
import {
  assertValidGrid,
  formatSceneGraphYaml,
  parseSceneGraph,
} from "../src/research/perception/scene-graph.ts";
import type { SceneGraph } from "../src/types/perception.ts";

const Z = (rows: number, cols: number): number[][] =>
  Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

describe("parseSceneGraph — validation", () => {
  test("empty grid throws", () => {
    expect(() => parseSceneGraph([])).toThrow(/empty grid/i);
  });

  test("ragged grid throws with row index and expected length", () => {
    const grid = [
      [0, 0, 0],
      [0, 1],
    ];
    expect(() => parseSceneGraph(grid)).toThrow(/ragged.*row 1.*expected 3/i);
  });

  test("non-numeric cell throws", () => {
    // @ts-expect-error — deliberately wrong input
    const grid = [[0, "x"]];
    expect(() => parseSceneGraph(grid)).toThrow(/\[0\]\[1\]/);
  });

  test("assertValidGrid accepts a normal grid", () => {
    expect(() => assertValidGrid([[0, 1], [2, 3]])).not.toThrow();
  });
});

describe("parseSceneGraph — connected components (8-connectivity)", () => {
  test("diagonally touching pixels merge into ONE object", () => {
    const grid = [
      [1, 0],
      [0, 1],
    ];
    const g = parseSceneGraph(grid);
    expect(g.objects).toHaveLength(1);
    expect(g.objects[0].pixels).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(g.objects[0].shapeCategory).toBe("irregular");
  });

  test("separated pixels stay separate objects, ids follow scan order", () => {
    const grid = [
      [5, 0, 3],
      [0, 0, 0],
      [7, 0, 9],
    ];
    const g = parseSceneGraph(grid);
    expect(g.objects.map((o) => o.id)).toEqual(["obj_0", "obj_1", "obj_2", "obj_3"]);
    expect(g.objects.every((o) => o.shapeCategory === "single_pixel")).toBe(true);
  });

  test("background is never an object", () => {
    const grid = Z(3, 3); // all background
    const g = parseSceneGraph(grid);
    expect(g.objects).toHaveLength(0);
    expect(g.relations).toHaveLength(0);
    expect(g.dominantColors).toHaveLength(0);
  });
});

describe("parseSceneGraph — shape categories", () => {
  test("full bbox = rectangle", () => {
    const grid = [
      [0, 0, 0, 0],
      [0, 2, 2, 0],
      [0, 2, 2, 0],
      [0, 0, 0, 0],
    ];
    expect(parseSceneGraph(grid).objects[0].shapeCategory).toBe("rectangle");
  });

  test("single row / single column of non-background = line", () => {
    const h = [
      [0, 0, 0],
      [4, 4, 4],
      [0, 0, 0],
    ];
    const v = [
      [0, 6, 0],
      [0, 6, 0],
      [0, 6, 0],
    ];
    expect(parseSceneGraph(h).objects[0].shapeCategory).toBe("line");
    expect(parseSceneGraph(v).objects[0].shapeCategory).toBe("line");
  });

  test("hollow border = frame", () => {
    const grid = [
      [1, 1, 1],
      [1, 0, 1],
      [1, 1, 1],
    ];
    const o = parseSceneGraph(grid).objects[0];
    expect(o.shapeCategory).toBe("frame");
    expect(o.pixels).toHaveLength(8);
  });

  test("L-shape = irregular", () => {
    const grid = [
      [3, 0],
      [3, 3],
    ];
    expect(parseSceneGraph(grid).objects[0].shapeCategory).toBe("irregular");
  });
});

describe("parseSceneGraph — symmetry on the object's own bounding box", () => {
  test("asymmetric shape reports no symmetry", () => {
    const grid = [
      [0, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 1, 1, 0],
      [0, 0, 0, 0],
    ];
    const sym = parseSceneGraph(grid).objects[0].symmetry;
    expect(sym.horizontal).toBe(false);
    expect(sym.vertical).toBe(false);
    expect(sym.diagonal).toBe(false);
  });

  test("horizontally mirrored shape has horizontal symmetry only", () => {
    // T-shape: symmetric left-right (vertical axis), not top-bottom.
    const grid = [
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    const sym = parseSceneGraph(grid).objects[0].symmetry;
    expect(sym.vertical).toBe(true);
    expect(sym.horizontal).toBe(false);
  });

  test("square block is symmetric on all three axes", () => {
    const grid = [
      [0, 0, 0, 0],
      [0, 2, 2, 0],
      [0, 2, 2, 0],
      [0, 0, 0, 0],
    ];
    const sym = parseSceneGraph(grid).objects[0].symmetry;
    expect(sym).toEqual({ horizontal: true, vertical: true, diagonal: true });
  });
});

describe("parseSceneGraph — relations", () => {
  test("inside: nested boxes report containment inner -> outer", () => {
    // Outer blue ring with a red pixel in the middle. NOTE: the red pixel
    // sits INSIDE the ring's hole, so it does not touch the ring.
    const grid = [
      [1, 1, 1, 1, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 2, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 1, 1, 1, 1],
    ];
    const g = parseSceneGraph(grid);
    const inside = g.relations.filter((r) => r.relation === "inside");
    expect(inside).toEqual([{ sourceId: "obj_1", targetId: "obj_0", relation: "inside" }]);
  });

  test("adjacent: objects separated by one background cell", () => {
    const grid = [
      [1, 0, 2],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const g = parseSceneGraph(grid);
    expect(g.relations.some((r) => r.relation === "adjacent")).toBe(true);
  });

  test("distant objects are not adjacent", () => {
    const grid = [
      [1, 0, 0, 0, 0, 2],
      [0, 0, 0, 0, 0, 0],
    ];
    expect(parseSceneGraph(grid).relations.some((r) => r.relation === "adjacent")).toBe(false);
  });

  test("aligned_horizontally shares a row band; aligned_vertically a column band", () => {
    const grid = [
      [0, 0, 0, 0],
      [0, 1, 0, 3],
      [0, 0, 0, 0],
    ];
    const g = parseSceneGraph(grid);
    expect(g.relations.some((r) => r.relation === "aligned_horizontally")).toBe(true);
    expect(g.relations.some((r) => r.relation === "aligned_vertically")).toBe(false);

    const vertical = parseSceneGraph([
      [0, 1, 0],
      [0, 0, 0],
      [0, 3, 0],
    ]);
    expect(vertical.relations.some((r) => r.relation === "aligned_vertically")).toBe(true);
    expect(vertical.relations.some((r) => r.relation === "aligned_horizontally")).toBe(false);
  });

  test("same_color and larger_than are reported with direction", () => {
    const grid = [
      [5, 5, 0, 5],
      [0, 0, 0, 0],
    ];
    const g = parseSceneGraph(grid);
    expect(g.relations).toContainEqual({ sourceId: "obj_0", targetId: "obj_1", relation: "same_color" });
    expect(g.relations).toContainEqual({ sourceId: "obj_0", targetId: "obj_1", relation: "larger_than" });
    expect(g.relations.filter((r) => r.relation === "larger_than")).toHaveLength(1);
  });
});

describe("parseSceneGraph — dominantColors", () => {
  test("sorted descending by count, background excluded, ties by color asc", () => {
    const grid = [
      [9, 3, 3],
      [3, 9, 9],
      [9, 3, 9],
    ]; // 9 appears 5 times, 3 four times
    const g = parseSceneGraph(grid);
    expect(g.dominantColors).toEqual([
      { color: 9, count: 5 },
      { color: 3, count: 4 },
    ]);

    const tied = [
      [4, 7],
      [7, 4],
    ];
    expect(parseSceneGraph(tied).dominantColors).toEqual([
      { color: 4, count: 2 },
      { color: 7, count: 2 },
    ]);
  });

  test("gridDimensions match the input", () => {
    const g: SceneGraph = parseSceneGraph(Z(7, 13));
    expect(g.gridDimensions).toEqual({ rows: 7, cols: 13 });
  });
});

describe("formatSceneGraphYaml", () => {
  test("exact output for a small pinned scene", () => {
    const grid = [
      [0, 0, 0, 0],
      [0, 2, 2, 5],
      [0, 2, 2, 0],
      [0, 0, 0, 0],
    ];
    const yaml = formatSceneGraphYaml(parseSceneGraph(grid));
    expect(yaml).toBe(
      [
        "scene: 4x4",
        "colors: 2x4, 5x1",
        "objects:",
        "- id: obj_0 color: 2 shape: rectangle bbox: [1,1,2,2] px: 4 sym: hvd",
        "- id: obj_1 color: 5 shape: single_pixel bbox: [3,1,1,1] px: 1 sym: hvd",
        "relations:",
        "- obj_0 adjacent obj_1",
        "- obj_0 aligned_horizontally obj_1",
        "- obj_0 larger_than obj_1",
      ].join("\n"),
    );
  });

  test("empty scene renders just the header", () => {
    expect(formatSceneGraphYaml(parseSceneGraph(Z(2, 3)))).toBe("scene: 2x3");
  });

  test("output stays compact for bigger scenes (prompt-friendly)", () => {
    // 12x12 random-ish grid must serialize to well under the raw cell count.
    const grid = Z(12, 12);
    for (let i = 0; i < 12; i++) grid[i][i] = 8;
    const yaml = formatSceneGraphYaml(parseSceneGraph(grid));
    expect(yaml.length).toBeLessThan(144); // raw grid has 144 cells
  });
});
