/**
 * dsl/primitives.ts — typed, pure grid primitives (spec §Module 2).
 *
 * Contract for every function in this file:
 *   - PURE: the input grid is never mutated; a fresh grid is returned.
 *   - SYNC: no I/O anywhere.
 *   - LOUD: structurally invalid input throws an Error whose message says
 *     what is wrong AND what was expected.
 *
 * Grid convention: number[row][col], rectangular, non-empty. Colors are
 * plain numbers; 0 is the conventional background for gravity/fill ops.
 *
 * After checkGrid() every indexed access below is in bounds by construction,
 * which is why the non-null assertions are sound (same discipline as the
 * rest of this codebase).
 */

import { assertValidGrid, parseSceneGraph } from "../../research/perception/scene-graph.ts";
import type { SpatialObject } from "../../types/perception.ts";

/** Shared structural check — every grid-taking primitive starts here. */
function checkGrid(grid: number[][], fn: string): void {
  try {
    assertValidGrid(grid);
  } catch (e) {
    throw new Error(`${fn}: ${(e as Error).message}`);
  }
}

/** Deep-clone helper used to return fresh grids. */
function cloneGrid(grid: number[][]): number[][] {
  return grid.map((row) => [...row]);
}

/**
 * Rotate `grid` by `deg` degrees, clockwise. Only 90, 180 and 270 are
 * defined — anything else throws. Output dimensions swap for 90/270.
 */
export function rotate(grid: number[][], deg: number): number[][] {
  checkGrid(grid, "rotate");
  if (deg !== 90 && deg !== 180 && deg !== 270) {
    throw new Error(`rotate: unsupported angle ${deg} — expected 90, 180, or 270`);
  }
  const rows = grid.length;
  const cols = grid[0]!.length;
  if (deg === 180) {
    const out: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
    for (let r = 0; r < rows; r++) {
      const row = grid[r]!;
      for (let c = 0; c < cols; c++) out[rows - 1 - r]![cols - 1 - c] = row[c]!;
    }
    return out;
  }
  // 90 and 270 swap dimensions.
  const out: number[][] = Array.from({ length: cols }, () => new Array<number>(rows).fill(0));
  if (deg === 90) {
    // clockwise: out[c][rows-1-r] = in[r][c]
    for (let r = 0; r < rows; r++) {
      const row = grid[r]!;
      for (let c = 0; c < cols; c++) out[c]![rows - 1 - r] = row[c]!;
    }
  } else {
    // 270 clockwise == 90 counter-clockwise: out[cols-1-c][r] = in[r][c]
    for (let r = 0; r < rows; r++) {
      const row = grid[r]!;
      for (let c = 0; c < cols; c++) out[cols - 1 - c]![r] = row[c]!;
    }
  }
  return out;
}

/**
 * Mirror across an axis:
 *   - 'horizontal' axis → row order reversed (flip upside-down)
 *   - 'vertical' axis   → column order reversed (flip left-right)
 */
export function mirror(grid: number[][], axis: "horizontal" | "vertical"): number[][] {
  checkGrid(grid, "mirror");
  if (axis !== "horizontal" && axis !== "vertical") {
    throw new Error(`mirror: unsupported axis "${String(axis)}" — expected "horizontal" or "vertical"`);
  }
  const rows = grid.length;
  const cols = grid[0]!.length;
  const out: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let r = 0; r < rows; r++) {
    const row = grid[r]!;
    for (let c = 0; c < cols; c++) {
      const targetRow = out[axis === "horizontal" ? rows - 1 - r : r]!;
      targetRow[axis === "vertical" ? cols - 1 - c : c] = row[c]!;
    }
  }
  return out;
}

/**
 * Shift content by `dx` columns (positive = right) and `dy` rows
 * (positive = down). Content pushed off the frame is dropped; vacated
 * cells take `fill` (default 0).
 */
export function shift(grid: number[][], dx: number, dy: number, fill = 0): number[][] {
  checkGrid(grid, "shift");
  if (!Number.isFinite(dx) || !Number.isInteger(dx)) {
    throw new Error(`shift: dx must be an integer, got ${String(dx)}`);
  }
  if (!Number.isFinite(dy) || !Number.isInteger(dy)) {
    throw new Error(`shift: dy must be an integer, got ${String(dy)}`);
  }
  if (typeof fill !== "number" || !Number.isFinite(fill)) {
    throw new Error(`shift: fill must be a finite number, got ${String(fill)}`);
  }
  const rows = grid.length;
  const cols = grid[0]!.length;
  const out: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(fill));
  for (let r = 0; r < rows; r++) {
    const row = grid[r]!;
    for (let c = 0; c < cols; c++) {
      const nr = r + dy;
      const nc = c + dx;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out[nr]![nc] = row[c]!;
    }
  }
  return out;
}

/** Bounding box shape shared with perception.SpatialObject.boundingBox. */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Extract the sub-grid at `bbox` ({x, y, width, height}, y = row offset).
 * The box must lie entirely inside the grid.
 */
export function crop(grid: number[][], bbox: BBox): number[][] {
  checkGrid(grid, "crop");
  const rows = grid.length;
  const cols = grid[0]!.length;
  const { x, y, width, height } = bbox;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(
      `crop: bbox fields x/y/width/height must all be integers, got ${JSON.stringify(bbox)}`,
    );
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`crop: bbox must have positive width and height, got ${width}x${height}`);
  }
  if (x < 0 || y < 0 || x + width > cols || y + height > rows) {
    throw new Error(
      `crop: bbox [x=${x}, y=${y}, w=${width}, h=${height}] exceeds grid bounds ${rows}x${cols}`,
    );
  }
  const out: number[][] = [];
  for (let r = y; r < y + height; r++) {
    out.push(grid[r]!.slice(x, x + width));
  }
  return out;
}

/**
 * Flood fill starting at (row, col), replacing the connected region of the
 * START color with `color`. Connectivity is 4-directional (up/down/left/right),
 * matching classic ARC flood-fill semantics. If the start cell already has
 * `color`, the grid is returned unchanged as a fresh copy.
 */
export function floodFill(grid: number[][], row: number, col: number, color: number): number[][] {
  checkGrid(grid, "floodFill");
  const rows = grid.length;
  const cols = grid[0]!.length;
  if (!Number.isInteger(row) || row < 0 || row >= rows) {
    throw new Error(`floodFill: row ${row} outside grid bounds 0..${rows - 1}`);
  }
  if (!Number.isInteger(col) || col < 0 || col >= cols) {
    throw new Error(`floodFill: col ${col} outside grid bounds 0..${cols - 1}`);
  }
  if (typeof color !== "number" || !Number.isFinite(color)) {
    throw new Error(`floodFill: color must be a finite number, got ${String(color)}`);
  }
  const target = grid[row]![col]!;
  const out = cloneGrid(grid);
  // Same-color fill is the identity — return before touching the stack so
  // there is nothing to loop over in the first place.
  if (target === color) return out;

  const visited = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const stack: Array<[number, number]> = [[row, col]];
  while (stack.length > 0) {
    const [r, c] = stack.pop()!;
    if (visited[r]![c]) continue;
    visited[r]![c] = true;
    if (out[r]![c] !== target) continue;
    out[r]![c] = color;
    if (r > 0) stack.push([r - 1, c]);
    if (r < rows - 1) stack.push([r + 1, c]);
    if (c > 0) stack.push([r, c - 1]);
    if (c < cols - 1) stack.push([r, c + 1]);
  }
  return out;
}

/**
 * Compact all non-zero cells toward `dir`, preserving their relative order,
 * filling vacated cells with 0 — gravity for tile games / ARC physics tasks.
 */
export function applyGravity(grid: number[][], dir: "down" | "up" | "left" | "right"): number[][] {
  checkGrid(grid, "applyGravity");
  if (dir !== "down" && dir !== "up" && dir !== "left" && dir !== "right") {
    throw new Error(`applyGravity: unsupported direction "${String(dir)}" — expected down, up, left, or right`);
  }
  const rows = grid.length;
  const cols = grid[0]!.length;
  const out: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  if (dir === "down" || dir === "up") {
    for (let c = 0; c < cols; c++) {
      const values: number[] = [];
      for (let r = 0; r < rows; r++) {
        const v = grid[r]![c]!;
        if (v !== 0) values.push(v);
      }
      if (dir === "down") {
        for (let i = 0; i < values.length; i++) out[rows - values.length + i]![c] = values[i]!;
      } else {
        for (let i = 0; i < values.length; i++) out[i]![c] = values[i]!;
      }
    }
  } else {
    for (let r = 0; r < rows; r++) {
      const values = grid[r]!.filter((v) => v !== 0);
      if (dir === "right") {
        for (let i = 0; i < values.length; i++) out[r]![cols - values.length + i] = values[i]!;
      } else {
        for (let i = 0; i < values.length; i++) out[r]![i] = values[i]!;
      }
    }
  }
  return out;
}

/**
 * Change every cell equal to `fromColor` into `toColor`.
 */
export function recolor(grid: number[][], fromColor: number, toColor: number): number[][] {
  checkGrid(grid, "recolor");
  if (typeof fromColor !== "number" || !Number.isFinite(fromColor)) {
    throw new Error(`recolor: fromColor must be a finite number, got ${String(fromColor)}`);
  }
  if (typeof toColor !== "number" || !Number.isFinite(toColor)) {
    throw new Error(`recolor: toColor must be a finite number, got ${String(toColor)}`);
  }
  return grid.map((row) => row.map((v) => (v === fromColor ? toColor : v)));
}

/** Alternate spec name for recolor — identical semantics. */
export function replaceColor(grid: number[][], oldColor: number, newColor: number): number[][] {
  return recolor(grid, oldColor, newColor);
}

/**
 * Parse the scene and keep only objects whose color matches `color`.
 * Uses the default background (0); selecting the background color therefore
 * yields [] by design — background pixels are not objects.
 */
export function selectByColor(grid: number[][], color: number | string): SpatialObject[] {
  checkGrid(grid, "selectByColor");
  return parseSceneGraph(grid).objects.filter((o) => o.color === color);
}

/** The object with the MOST pixels. Ties resolve to scan order (first wins). */
export function selectLargest(objects: SpatialObject[]): SpatialObject {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new Error("selectLargest: empty object list — expected at least one SpatialObject");
  }
  let best = objects[0]!;
  for (const o of objects) {
    if (o.pixels.length > best.pixels.length) best = o;
  }
  return best;
}

/** The object with the FEWEST pixels. Ties resolve to scan order (first wins). */
export function selectSmallest(objects: SpatialObject[]): SpatialObject {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new Error("selectSmallest: empty object list — expected at least one SpatialObject");
  }
  let best = objects[0]!;
  for (const o of objects) {
    if (o.pixels.length < best.pixels.length) best = o;
  }
  return best;
}
