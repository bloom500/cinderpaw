/**
 * causal-explorer.test.ts — CausalRule induction from SceneGraph diffs.
 *
 * Runner-agnostic (bun:test → vitest fallback), same pattern as
 * mcts-verifier.test.ts.
 */

interface RunnerLike {
  describe: (name: string, fn: () => void) => void;
  test: (name: string, fn: () => void | Promise<void>) => void;
  // biome-ignore lint/suspicious/noExplicitAny: structural runner typing
  expect: any;
}

async function loadRunner(): Promise<RunnerLike> {
  try {
    const mod = await import("bun:test");
    return { describe: mod.describe, test: mod.test, expect: mod.expect };
  } catch {
    const mod = await import("./_runner-vitest.ts");
    return { describe: mod.describe, test: mod.test ?? mod.it, expect: mod.expect };
  }
}

const { describe, test, expect } = await loadRunner();

import { detectCausalDiff } from "../src/perception/causal-explorer.ts";
import type { SceneGraph, SpatialObject } from "../src/types/perception.ts";

function obj(id: string, overrides: Partial<SpatialObject> = {}): SpatialObject {
  return {
    id,
    color: 1,
    boundingBox: { x: 0, y: 0, width: 1, height: 1 },
    pixels: [[0, 0]],
    shapeCategory: "single_pixel",
    symmetry: { horizontal: false, vertical: false, diagonal: false },
    ...overrides,
  };
}

function graph(objects: SpatialObject[]): SceneGraph {
  return {
    gridDimensions: { rows: 8, cols: 8 },
    objects,
    relations: [],
    dominantColors: [],
  };
}

describe("detectCausalDiff", () => {
  test("movement changes are reported as position (+size) on the moved object", () => {
    const before = graph([obj("a", { boundingBox: { x: 1, y: 1, width: 2, height: 2 }, pixels: [[1, 1], [1, 2], [2, 1], [2, 2]] })]);
    const after = graph([obj("a", { boundingBox: { x: 3, y: 1, width: 2, height: 2 }, pixels: [[1, 3], [1, 4], [2, 3], [2, 4]] })]);
    const rule = detectCausalDiff(before, after, "ACTION4");
    expect(rule.action).toBe("ACTION4");
    expect(rule.affectedObjects).toEqual(["a"]);
    const props = rule.propertyChange.map((c) => c.property);
    expect(props).toContain("position");
    const pos = rule.propertyChange.find((c) => c.property === "position");
    expect(pos.before).toEqual({ x: 1, y: 1 });
    expect(pos.after).toEqual({ x: 3, y: 1 });
  });

  test("recolor is detected without touching position", () => {
    const before = graph([obj("b", { color: 3 })]);
    const after = graph([obj("b", { color: 5 })]);
    const rule = detectCausalDiff(before, after, { name: "recolor_action" });
    expect(rule.action).toBe("recolor_action");
    expect(rule.affectedObjects).toEqual(["b"]);
    expect(rule.propertyChange.length).toBe(1);
    expect(rule.propertyChange[0].property).toBe("color");
    expect(rule.propertyChange[0].before).toBe(3);
    expect(rule.propertyChange[0].after).toBe(5);
  });

  test("object creation/deletion becomes an existence change", () => {
    const before = graph([obj("kept"), obj("gone")]);
    const after = graph([obj("kept"), obj("new")]);
    const rule = detectCausalDiff(before, after, "spawn");
    expect(rule.affectedObjects).toEqual(["gone", "new"]);
    const gone = rule.propertyChange.find((c) => c.objectId === "gone");
    const created = rule.propertyChange.find((c) => c.objectId === "new");
    expect(gone.property).toBe("existence");
    expect(gone.after).toBe("absent");
    expect(created.before).toBe("absent");
    expect(created.after).toBe("present");
  });

  test("identical graphs yield an empty rule", () => {
    const g = graph([obj("a"), obj("b", { id: "b", color: 7 })]);
    const rule = detectCausalDiff(g, JSON.parse(JSON.stringify(g)), "noop");
    expect(rule.action).toBe("noop");
    expect(rule.affectedObjects).toEqual([]);
    expect(rule.propertyChange).toEqual([]);
  });

  test("deterministic ordering of affected objects and properties", () => {
    const before = graph([obj("z", { color: 1 }), obj("a", { color: 2 }), obj("m", { color: 3 })]);
    const after = graph([obj("z", { color: 9 }), obj("a", { color: 8 }), obj("m", { color: 7 })]);
    const r1 = detectCausalDiff(before, after, "X");
    const r2 = detectCausalDiff(before, after, "X");
    expect(r1.affectedObjects).toEqual(["a", "m", "z"]);
    expect(r1).toEqual(r2);
  });

  test("shape and pixel-pattern changes are tracked", () => {
    const before = graph([obj("s", { shapeCategory: "line", pixels: [[0, 0], [0, 1]] })]);
    const after = graph([obj("s", { shapeCategory: "rectangle", pixels: [[0, 0], [0, 1], [1, 0], [1, 1]] })]);
    const rule = detectCausalDiff(before, after, "grow");
    const props = rule.propertyChange.map((c) => c.property);
    expect(props).toContain("shapeCategory");
    expect(props).toContain("pixelPattern");
  });

  test("loud on invalid inputs", () => {
    const good = graph([obj("a")]);
    expect(() => detectCausalDiff(null as unknown as SceneGraph, good, "A")).toThrow(/beforeGraph/);
    expect(() => detectCausalDiff(good, {} as unknown as SceneGraph, "A")).toThrow(/not a valid SceneGraph/);
    expect(() => detectCausalDiff(good, good, "")).toThrow(/non-empty action name/);
    expect(() => detectCausalDiff(good, good, undefined as unknown as string)).toThrow(
      /must be a non-empty string or \{ name/,
    );
  });
});
