/**
 * DSL Standard Library Primitives.
 *
 * Deterministic, pure matrix transformation and object manipulation functions
 * exposed directly to the RLM JS REPL environment (`FeralAgent/src/rlm/repl.ts`).
 */

export type Grid = Array<Array<number | string>>;

/**
 * Rotates a 2D grid clockwise by 90, 180, or 270 degrees.
 */
export function rotateGrid(grid: Grid, degrees: 90 | 180 | 270): Grid {
  if (grid.length === 0 || grid[0].length === 0) return [];

  const rows = grid.length;
  const cols = grid[0].length;

  if (degrees === 90) {
    const result: Grid = Array.from({ length: cols }, () =>
      Array(rows).fill(0)
    );
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        result[c][rows - 1 - r] = grid[r][c];
      }
    }
    return result;
  }

  if (degrees === 180) {
    const result: Grid = Array.from({ length: rows }, () =>
      Array(cols).fill(0)
    );
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        result[rows - 1 - r][cols - 1 - c] = grid[r][c];
      }
    }
    return result;
  }

  if (degrees === 270) {
    const result: Grid = Array.from({ length: cols }, () =>
      Array(rows).fill(0)
    );
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        result[cols - 1 - c][r] = grid[r][c];
      }
    }
    return result;
  }

  return grid;
}

/**
 * Mirrors a 2D grid along the horizontal or vertical axis.
 */
export function mirrorGrid(grid: Grid, axis: "horizontal" | "vertical"): Grid {
  if (grid.length === 0 || grid[0].length === 0) return [];

  const rows = grid.length;
  const cols = grid[0].length;
  const result: Grid = grid.map((row) => [...row]);

  if (axis === "horizontal") {
    // Flip rows vertically
    return result.reverse();
  } else {
    // Flip columns horizontally
    return result.map((row) => row.reverse());
  }
}

/**
 * Replaces all occurrences of `fromColor` with `toColor`.
 */
export function recolorGrid(
  grid: Grid,
  fromColor: number | string,
  toColor: number | string
): Grid {
  return grid.map((row) =>
    row.map((val) => (val === fromColor ? toColor : val))
  );
}

/**
 * Performs a flood fill starting at [row, col] with `fillColor`.
 */
export function floodFillGrid(
  grid: Grid,
  startRow: number,
  startCol: number,
  fillColor: number | string
): Grid {
  if (grid.length === 0 || grid[0].length === 0) return grid;
  const rows = grid.length;
  const cols = grid[0].length;

  if (
    startRow < 0 ||
    startRow >= rows ||
    startCol < 0 ||
    startCol >= cols
  ) {
    return grid;
  }

  const targetColor = grid[startRow][startCol];
  if (targetColor === fillColor) return grid;

  const result: Grid = grid.map((row) => [...row]);
  const queue: Array<[number, number]> = [[startRow, startCol]];
  result[startRow][startCol] = fillColor;

  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (
        nr >= 0 &&
        nr < rows &&
        nc >= 0 &&
        nc < cols &&
        result[nr][nc] === targetColor
      ) {
        result[nr][nc] = fillColor;
        queue.push([nr, nc]);
      }
    }
  }

  return result;
}

/**
 * Crops a grid to the specified bounding box {x, y, width, height}.
 */
export function cropGrid(
  grid: Grid,
  bbox: { x: number; y: number; width: number; height: number }
): Grid {
  if (grid.length === 0 || grid[0].length === 0) return [];

  const cropped: Grid = [];
  for (let r = bbox.y; r < bbox.y + bbox.height && r < grid.length; r++) {
    const row: Array<number | string> = [];
    for (let c = bbox.x; c < bbox.x + bbox.width && c < grid[0].length; c++) {
      row.push(grid[r][c]);
    }
    cropped.push(row);
  }
  return cropped;
}

/**
 * Applies a directional gravity force, shifting non-zero elements until they hit an obstacle or border.
 */
export function applyGravityGrid(
  grid: Grid,
  direction: "down" | "up" | "left" | "right" = "down",
  backgroundColor: number | string = 0
): Grid {
  if (grid.length === 0 || grid[0].length === 0) return grid;
  const rows = grid.length;
  const cols = grid[0].length;
  const result: Grid = grid.map((row) => [...row]);

  if (direction === "down") {
    for (let c = 0; c < cols; c++) {
      let emptyRow = rows - 1;
      for (let r = rows - 1; r >= 0; r--) {
        if (result[r][c] !== backgroundColor) {
          const val = result[r][c];
          result[r][c] = backgroundColor;
          result[emptyRow][c] = val;
          emptyRow--;
        }
      }
    }
  }

  return result;
}

/**
 * Complete DSL Primitive Bundle exposed to the RLM REPL context.
 */
export const DSL_PRIMITIVES = {
  rotate: rotateGrid,
  mirror: mirrorGrid,
  recolor: recolorGrid,
  floodFill: floodFillGrid,
  crop: cropGrid,
  applyGravity: applyGravityGrid,
};
