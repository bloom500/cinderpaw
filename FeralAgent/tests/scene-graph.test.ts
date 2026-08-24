import { describe, expect, it } from "vitest";
import {
  formatSceneGraphToYaml,
  parseSceneGraph,
} from "../src/perception/scene-graph.js";

describe("Scene Graph Perception Module", () => {
  it("parses empty grid correctly", () => {
    const graph = parseSceneGraph([]);
    expect(graph.gridDimensions).toEqual({ rows: 0, cols: 0 });
    expect(graph.objects).toHaveLength(0);
    expect(graph.relations).toHaveLength(0);
  });

  it("extracts single pixel object", () => {
    const grid = [
      [0, 0, 0],
      [0, 3, 0],
      [0, 0, 0],
    ];

    const graph = parseSceneGraph(grid);
    expect(graph.gridDimensions).toEqual({ rows: 3, cols: 3 });
    expect(graph.objects).toHaveLength(1);

    const obj = graph.objects[0];
    expect(obj.id).toBe("obj_1");
    expect(obj.color).toBe(3);
    expect(obj.pixelCount).toBe(1);
    expect(obj.shapeCategory).toBe("single_pixel");
    expect(obj.boundingBox).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it("extracts rectangle object and checks symmetry", () => {
    const grid = [
      [0, 0, 0, 0],
      [0, 2, 2, 0],
      [0, 2, 2, 0],
      [0, 0, 0, 0],
    ];

    const graph = parseSceneGraph(grid);
    expect(graph.objects).toHaveLength(1);

    const obj = graph.objects[0];
    expect(obj.color).toBe(2);
    expect(obj.pixelCount).toBe(4);
    expect(obj.shapeCategory).toBe("rectangle");
    expect(obj.symmetry.horizontal).toBe(true);
    expect(obj.symmetry.vertical).toBe(true);
  });

  it("detects spatial relations between two objects (larger_than, aligned, inside)", () => {
    const grid = [
      [1, 1, 1, 0, 5],
      [1, 1, 1, 0, 0],
      [1, 1, 1, 0, 0],
    ];

    const graph = parseSceneGraph(grid);
    expect(graph.objects).toHaveLength(2);

    const obj1 = graph.objects.find((o) => o.color === 1)!;
    const obj2 = graph.objects.find((o) => o.color === 5)!;

    expect(obj1.pixelCount).toBe(9);
    expect(obj2.pixelCount).toBe(1);

    const largerThan = graph.relations.find(
      (r) =>
        r.sourceId === obj1.id &&
        r.targetId === obj2.id &&
        r.relation === "larger_than"
    );
    expect(largerThan).toBeDefined();

    const aligned = graph.relations.find(
      (r) =>
        r.sourceId === obj1.id &&
        r.targetId === obj2.id &&
        r.relation === "aligned_horizontally"
    );
    expect(aligned).toBeDefined();
  });

  it("formats SceneGraph to clean YAML string", () => {
    const grid = [
      [0, 4, 4],
      [0, 4, 4],
    ];

    const graph = parseSceneGraph(grid);
    const yaml = formatSceneGraphToYaml(graph);

    expect(yaml).toContain("dimensions: 2x3");
    expect(yaml).toContain("objects_count: 1");
    expect(yaml).toContain("color: 4");
    expect(yaml).toContain("shape: rectangle");
  });
});
