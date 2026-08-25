import { describe, expect, it } from "vitest";
import { detectCausalDiff } from "../src/perception/causal-explorer.js";
import { SceneGraph } from "../src/types/perception.js";

describe("Causal Explorer Module", () => {
  it("detects no changes when before and after graphs match", () => {
    const graph: SceneGraph = {
      gridDimensions: { rows: 2, cols: 2 },
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
      dominantColors: [{ color: 1, count: 1 }],
    };

    const rule = detectCausalDiff(graph, graph, "ACTION1");
    expect(rule.affectedObjectIds).toHaveLength(0);
    expect(rule.propertyChanges).toHaveLength(0);
    expect(rule.summary).toContain("no state changes");
  });

  it("detects object position movement and recoloring", () => {
    const beforeGraph: SceneGraph = {
      gridDimensions: { rows: 3, cols: 3 },
      objects: [
        {
          id: "obj_1",
          color: 2,
          pixelCount: 1,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
          pixels: [[0, 0]],
          shapeCategory: "single_pixel",
          symmetry: { horizontal: true, vertical: true },
        },
      ],
      relations: [],
      dominantColors: [{ color: 2, count: 1 }],
    };

    const afterGraph: SceneGraph = {
      gridDimensions: { rows: 3, cols: 3 },
      objects: [
        {
          id: "obj_1",
          color: 4, // Recolored
          pixelCount: 1,
          boundingBox: { x: 1, y: 0, width: 1, height: 1 }, // Moved right
          pixels: [[0, 1]],
          shapeCategory: "single_pixel",
          symmetry: { horizontal: true, vertical: true },
        },
      ],
      relations: [],
      dominantColors: [{ color: 4, count: 1 }],
    };

    const rule = detectCausalDiff(beforeGraph, afterGraph, "MOVE_RIGHT");
    expect(rule.affectedObjectIds).toContain("obj_1");
    expect(rule.propertyChanges).toHaveLength(2); // position + color
    expect(rule.summary).toContain("recolored");
    expect(rule.summary).toContain("moved");
  });
});
