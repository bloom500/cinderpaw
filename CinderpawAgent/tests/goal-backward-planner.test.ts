/**
 * goal-backward-planner.test.ts — backward chaining from the victory image.
 * Runner-agnostic (bun:test → vitest fallback).
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

import { planBackwardFromGoal } from "../src/core/goal-backward-planner.ts";
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
  return { gridDimensions: { rows: 8, cols: 8 }, objects, relations: [], dominantColors: [] };
}

describe("planBackwardFromGoal", () => {
  test("missing target object → create sub-goal without dependencies", () => {
    const plan = planBackwardFromGoal(graph([obj("g1")]), graph([]));
    expect(plan.length).toBe(1);
    expect(plan[0]).toMatchObject({ id: "create:g1", kind: "create", objectId: "g1", dependsOn: [] });
  });

  test("wrong color/position/size chains into ordered dependent sub-goals", () => {
    const target = graph([obj("o", { color: 5, boundingBox: { x: 3, y: 4, width: 2, height: 2 } })]);
    const current = graph([obj("o", { color: 1, boundingBox: { x: 0, y: 0, width: 1, height: 1 } })]);
    const plan = planBackwardFromGoal(target, current);

    expect(plan.map((g) => g.id)).toEqual(["recolor:o", "move:o", "resize:o"]);
    expect(plan[0].dependsOn).toEqual([]);
    expect(plan[1].dependsOn).toEqual(["recolor:o"]);
    expect(plan[2].dependsOn).toEqual(["move:o"]);
  });

  test("extra current objects absent from the victory image get removal goals", () => {
    const plan = planBackwardFromGoal(graph([obj("keep")]), graph([obj("keep"), obj("junk"), obj("zzz")]));
    const removals = plan.filter((g) => g.kind === "remove");
    expect(removals.map((g) => g.id)).toEqual(["remove:junk", "remove:zzz"]);
  });

  test("already-satisfied state produces an empty plan", () => {
    const g = graph([obj("a"), obj("b", { id: "b", color: 7 })]);
    expect(planBackwardFromGoal(g, JSON.parse(JSON.stringify(g)))).toEqual([]);
  });

  test("dependencies always reference strictly earlier entries (executable top-to-bottom)", () => {
    const target = graph([
      obj("b", { color: 9, boundingBox: { x: 2, y: 2, width: 3, height: 1 } }),
      obj("a", { color: 8 }),
      obj("new"),
    ]);
    const current = graph([
      obj("b", { color: 2, boundingBox: { x: 0, y: 0, width: 1, height: 1 } }),
      obj("a"),
      obj("stale"),
    ]);
    const plan = planBackwardFromGoal(target, current);
    const indexOf = new Map(plan.map((g, i) => [g.id, i]));
    for (const goal of plan) {
      for (const dep of goal.dependsOn) {
        expect(indexOf.get(dep)!).toBeLessThan(indexOf.get(goal.id)!);
      }
    }
  });

  test("deterministic ordering across runs", () => {
    const target = graph([obj("z", { color: 5 }), obj("a")]);
    const current = graph([obj("z"), obj("a", { color: 3 })]);
    expect(planBackwardFromGoal(target, current)).toEqual(planBackwardFromGoal(target, current));
  });

  test("loud on invalid graphs", () => {
    const good = graph([obj("a")]);
    expect(() => planBackwardFromGoal(null as never, good)).toThrow(/targetGraph/);
    expect(() => planBackwardFromGoal(good, {} as never)).toThrow(/not a valid SceneGraph/);
  });
});
