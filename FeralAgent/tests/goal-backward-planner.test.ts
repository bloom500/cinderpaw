import { describe, expect, it } from "vitest";
import { planBackwardFromGoal } from "../src/core/goal-backward-planner.js";
import { SceneGraph } from "../src/types/perception.js";

describe("Goal Backward Planner", () => {
  it("generates recolor and move sub-goals when object exists in current and target", () => {
    const currentGraph: SceneGraph = {
      gridDimensions: { rows: 3, cols: 3 },
      objects: [
        {
          id: "obj_1",
          color: 1,
          pixelCount: 1,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
          pixels: [[0, 0]],
          shapeCategory: "single_pixel",
          symmetry: { horizontal: true, vertical: true },
        },
      ],
      relations: [],
      dominantColors: [],
    };

    const targetGraph: SceneGraph = {
      gridDimensions: { rows: 3, cols: 3 },
      objects: [
        {
          id: "obj_1",
          color: 5, // Recolor needed
          pixelCount: 1,
          boundingBox: { x: 2, y: 2, width: 1, height: 1 }, // Move needed
          pixels: [[2, 2]],
          shapeCategory: "single_pixel",
          symmetry: { horizontal: true, vertical: true },
        },
      ],
      relations: [],
      dominantColors: [],
    };

    const plan = planBackwardFromGoal(currentGraph, targetGraph);
    expect(plan.goals).toHaveLength(2);
    expect(plan.goals.some((g) => g.type === "recolor")).toBe(true);
    expect(plan.goals.some((g) => g.type === "move")).toBe(true);
  });

  it("generates create sub-goal when object is missing in current", () => {
    const currentGraph: SceneGraph = {
      gridDimensions: { rows: 3, cols: 3 },
      objects: [],
      relations: [],
      dominantColors: [],
    };

    const targetGraph: SceneGraph = {
      gridDimensions: { rows: 3, cols: 3 },
      objects: [
        {
          id: "obj_2",
          color: 3,
          pixelCount: 1,
          boundingBox: { x: 1, y: 1, width: 1, height: 1 },
          pixels: [[1, 1]],
          shapeCategory: "single_pixel",
          symmetry: { horizontal: true, vertical: true },
        },
      ],
      relations: [],
      dominantColors: [],
    };

    const plan = planBackwardFromGoal(currentGraph, targetGraph);
    expect(plan.goals.some((g) => g.type === "create")).toBe(true);
  });
});
