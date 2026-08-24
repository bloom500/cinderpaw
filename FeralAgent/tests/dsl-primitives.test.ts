import { describe, expect, it } from "vitest";
import {
  applyGravityGrid,
  cropGrid,
  floodFillGrid,
  mirrorGrid,
  recolorGrid,
  rotateGrid,
} from "../src/rlm/dsl/primitives.js";

describe("DSL Primitives Library", () => {
  it("rotates grid 90 degrees clockwise", () => {
    const grid = [
      [1, 2],
      [3, 4],
    ];
    const rotated = rotateGrid(grid, 90);
    expect(rotated).toEqual([
      [3, 1],
      [4, 2],
    ]);
  });

  it("mirrors grid horizontally and vertically", () => {
    const grid = [
      [1, 2],
      [3, 4],
    ];
    const horiz = mirrorGrid(grid, "horizontal");
    expect(horiz).toEqual([
      [3, 4],
      [1, 2],
    ]);

    const vert = mirrorGrid(grid, "vertical");
    expect(vert).toEqual([
      [2, 1],
      [4, 3],
    ]);
  });

  it("recolors values in grid", () => {
    const grid = [
      [1, 0, 1],
      [0, 1, 0],
    ];
    const recolored = recolorGrid(grid, 1, 9);
    expect(recolored).toEqual([
      [9, 0, 9],
      [0, 9, 0],
    ]);
  });

  it("performs flood fill correctly", () => {
    const grid = [
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, 2],
    ];
    const filled = floodFillGrid(grid, 0, 0, 7);
    expect(filled).toEqual([
      [7, 7, 0],
      [7, 0, 0],
      [0, 0, 2],
    ]);
  });

  it("crops grid to bounding box", () => {
    const grid = [
      [0, 0, 0, 0],
      [0, 5, 5, 0],
      [0, 5, 5, 0],
      [0, 0, 0, 0],
    ];
    const cropped = cropGrid(grid, { x: 1, y: 1, width: 2, height: 2 });
    expect(cropped).toEqual([
      [5, 5],
      [5, 5],
    ]);
  });

  it("applies downward gravity to floating pixels", () => {
    const grid = [
      [1, 0, 2],
      [0, 0, 0],
      [0, 3, 0],
    ];
    const grav = applyGravityGrid(grid, "down");
    expect(grav).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [1, 3, 2],
    ]);
  });
});
