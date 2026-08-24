/**
 * scene-graph.ts — Scene Graph Perception for 2D grids (spec §Module 1).
 *
 * Converts a raw numeric grid into a typed object graph:
 *   1. Connected Component Analysis (8-connectivity) over non-background cells.
 *   2. Per-object features: bounding box, pixel list, shape category, symmetries.
 *   3. Pairwise relation graph (inside / adjacent / alignment / color / size).
 *   4. Compact YAML formatting sized for LLM prompts (~150 tokens per scene).
 *
 * Pure functions only — no I/O, no mutation of the input grid.
 */

import type {
  SceneGraph,
  SpatialObject,
  SpatialRelation,
} from "../../types/perception.ts";

/** Thrown on structurally invalid grid input. Message says what is wrong and what was expected. */
export class GridFormatError extends Error {}

/**
 * Structural validation shared by the parser. A valid grid is a non-empty
 * array of non-empty rows, all rows the same length, every cell a finite number.
 */
export function assertValidGrid(grid: unknown, label = "grid"): asserts grid is number[][] {
  if (!Array.isArray(grid)) {
    throw new GridFormatError(`${label}: expected number[][], got ${typeof grid}`);
  }
  if (grid.length === 0) {
    throw new GridFormatError(`${label}: empty grid — expected at least one row`);
  }
  const cols = (grid[0] as unknown[]).length;
  if (cols === 0) {
    throw new GridFormatError(`${label}: row 0 is empty — expected at least one column`);
  }
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] as unknown;
    if (!Array.isArray(row)) {
      throw new GridFormatError(`${label}: row ${r} is not an array — expected number[][] with uniform row length ${cols}`);
    }
    if (row.length !== cols) {
      throw new GridFormatError(
        `${label}: ragged grid — row ${r} has ${row.length} cells, expected ${cols} (all rows must match row 0)`,
      );
    }
    for (let c = 0; c < cols; c++) {
      const cell = row[c] as unknown;
      if (typeof cell !== "number" || !Number.isFinite(cell)) {
        throw new GridFormatError(`${label}: cell [${r}][${c}] is ${String(cell)} — expected a finite number`);
      }
    }
  }
}

interface Component {
  color: number;
  pixels: Array<[number, number]>;
}

/**
 * Connected Component Analysis with 8-connectivity: pixels group when they
 * touch horizontally, vertically, OR diagonally. Scan order is row-major,
 * so component ids are deterministic for a given grid.
 *
 * Precondition: the grid passed assertValidGrid — every indexed access below
 * is in bounds, which is why the non-null assertions are sound.
 */
function connectedComponents(grid: number[][], background: number): Component[] {
  const rows = grid.length;
  const cols = grid[0]!.length;
  const seen = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const components: Component[] = [];

  for (let r = 0; r < rows; r++) {
    const row = grid[r]!;
    for (let c = 0; c < cols; c++) {
      if (seen[r]![c]) continue;
      const color = row[c]!;
      seen[r]![c] = true;
      if (color === background) continue;

      // Iterative flood fill — deep components must not blow the call stack.
      const pixels: Array<[number, number]> = [];
      const stack: Array<[number, number]> = [[r, c]];
      while (stack.length > 0) {
        const [pr, pc] = stack.pop()!;
        pixels.push([pr, pc]);
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = pr + dr;
            const nc = pc + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            if (seen[nr]![nc]) continue;
            if (grid[nr]![nc] !== color) continue;
            seen[nr]![nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
      // Row-major scan order inside the component keeps pixel lists stable.
      pixels.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
      components.push({ color, pixels });
    }
  }
  return components;
}

/**
 * Symmetry checks run on the object's OWN bounding box: a w×h boolean mask
 * of the object's pixels is mirrored and compared against itself. Foreign
 * objects sharing the box are invisible to these checks.
 */
function computeSymmetry(
  pixels: Array<[number, number]>,
  bbox: { x: number; y: number; width: number; height: number },
): { horizontal: boolean; vertical: boolean; diagonal: boolean } {
  const { width: w, height: h } = bbox;
  const mask = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  for (const [r, c] of pixels) mask[r - bbox.y]![c - bbox.x] = true;

  let horizontal = true; // mirror across the horizontal axis (rows reversed)
  let vertical = true; // mirror across the vertical axis (columns reversed)
  // Diagonal (transpose) symmetry is only defined on a square bounding box —
  // transposing a 2x3 shape yields dimensions no mask can match.
  let diagonal = w === h;
  for (let r = 0; r < h && (horizontal || vertical || diagonal); r++) {
    for (let c = 0; c < w && (horizontal || vertical || diagonal); c++) {
      if (mask[r]![c] !== mask[h - 1 - r]![c]) horizontal = false;
      if (mask[r]![c] !== mask[r]![w - 1 - c]) vertical = false;
      if (diagonal && mask[r]![c] !== mask[c]![r]) diagonal = false;
    }
  }
  return { horizontal, vertical, diagonal };
}

function classifyShape(
  pixelCount: number,
  bbox: { x: number; y: number; width: number; height: number },
): SpatialObject["shapeCategory"] {
  const area = bbox.width * bbox.height;
  if (pixelCount === 1) return "single_pixel";
  if (bbox.height === 1 || bbox.width === 1) return "line";
  if (pixelCount === area) return "rectangle";
  // frame: the entire border of the bbox is covered, the interior is empty.
  if (area > 4 && pixelCount === 2 * (bbox.width + bbox.height) - 4) return "frame";
  return "irregular";
}

/**
 * Parse a raw grid into a SceneGraph.
 *
 * `background` (default 0) is the color treated as empty space — it never
 * becomes an object and is excluded from dominantColors.
 *
 * Relation semantics (deterministic, documented for test pinning):
 * - inside:                source's bbox is fully contained in target's bbox.
 * - adjacent:              the bboxes touch when each is expanded by one cell
 *                          (gap of at most one background cell between them).
 * - aligned_horizontally:  the two bboxes share at least one grid ROW
 *                          (they sit in the same horizontal band).
 * - aligned_vertically:    the two bboxes share at least one grid COLUMN.
 * - same_color:            identical color values (emitted once per pair).
 * - larger_than:           strictly more pixels (emitted directionally, from
 *                          the bigger object to the smaller one).
 */
export function parseSceneGraph(grid: number[][], background: number = 0): SceneGraph {
  assertValidGrid(grid);
  if (typeof background !== "number" || !Number.isFinite(background)) {
    throw new GridFormatError(`background: expected a finite number, got ${String(background)}`);
  }

  const rows = grid.length;
  const cols = grid[0]!.length;
  const components = connectedComponents(grid, background);

  const objects: SpatialObject[] = components.map((comp, i) => {
    let minY = Infinity;
    let minX = Infinity;
    let maxY = -Infinity;
    let maxX = -Infinity;
    for (const [r, c] of comp.pixels) {
      if (r < minY) minY = r;
      if (r > maxY) maxY = r;
      if (c < minX) minX = c;
      if (c > maxX) maxX = c;
    }
    const bbox = {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
    return {
      id: `obj_${i}`,
      color: comp.color,
      boundingBox: bbox,
      pixels: comp.pixels,
      shapeCategory: classifyShape(comp.pixels.length, bbox),
      symmetry: computeSymmetry(comp.pixels, bbox),
    };
  });

  const relations: SpatialRelation[] = [];
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = objects[i]!;
      const b = objects[j]!;
      const aBox = a.boundingBox;
      const bBox = b.boundingBox;

      const containedAB =
        aBox.x >= bBox.x &&
        aBox.y >= bBox.y &&
        aBox.x + aBox.width <= bBox.x + bBox.width &&
        aBox.y + aBox.height <= bBox.y + bBox.height;
      const containedBA =
        bBox.x >= aBox.x &&
        bBox.y >= aBox.y &&
        bBox.x + bBox.width <= aBox.x + aBox.width &&
        bBox.y + bBox.height <= aBox.y + aBox.height;

      // Expanded-by-one rectangle intersection == gap of ≤1 background cell.
      const adjacent =
        aBox.x - 1 <= bBox.x + bBox.width &&
        bBox.x - 1 <= aBox.x + aBox.width &&
        aBox.y - 1 <= bBox.y + bBox.height &&
        bBox.y - 1 <= aBox.y + aBox.height;

      const sharesRow = aBox.y < bBox.y + bBox.height && bBox.y < aBox.y + aBox.height;
      const sharesCol = aBox.x < bBox.x + bBox.width && bBox.x < aBox.x + aBox.width;

      if (containedAB || containedBA) {
        const inner = containedAB ? a : b;
        const outer = containedAB ? b : a;
        relations.push({ sourceId: inner.id, targetId: outer.id, relation: "inside" });
      }
      if (adjacent) {
        relations.push({ sourceId: a.id, targetId: b.id, relation: "adjacent" });
      }
      if (sharesRow) {
        relations.push({ sourceId: a.id, targetId: b.id, relation: "aligned_horizontally" });
      }
      if (sharesCol) {
        relations.push({ sourceId: a.id, targetId: b.id, relation: "aligned_vertically" });
      }
      if (a.color === b.color) {
        relations.push({ sourceId: a.id, targetId: b.id, relation: "same_color" });
      }
      if (a.pixels.length > b.pixels.length) {
        relations.push({ sourceId: a.id, targetId: b.id, relation: "larger_than" });
      } else if (b.pixels.length > a.pixels.length) {
        relations.push({ sourceId: b.id, targetId: a.id, relation: "larger_than" });
      }
    }
  }

  const counts = new Map<number, number>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r]![c]!;
      if (v === background) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const dominantColors = [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((p, q) => q.count - p.count || p.color - q.color);

  return {
    gridDimensions: { rows, cols },
    objects,
    relations,
    dominantColors,
  };
}

/**
 * Format a SceneGraph as compact YAML intended to replace the raw 2D array
 * in an LLM prompt. Deterministic: identical graphs always serialize to
 * byte-identical strings.
 */
export function formatSceneGraphYaml(g: SceneGraph): string {
  const lines: string[] = [];
  lines.push(`scene: ${g.gridDimensions.rows}x${g.gridDimensions.cols}`);

  if (g.dominantColors.length > 0) {
    lines.push(`colors: ${g.dominantColors.map((d) => `${d.color}x${d.count}`).join(", ")}`);
  }

  if (g.objects.length > 0) {
    lines.push("objects:");
    for (const o of g.objects) {
      const b = o.boundingBox;
      const sym =
        [o.symmetry.horizontal && "h", o.symmetry.vertical && "v", o.symmetry.diagonal && "d"]
          .filter(Boolean)
          .join("") || "-";
      lines.push(
        `- id: ${o.id} color: ${o.color} shape: ${o.shapeCategory}` +
          ` bbox: [${b.x},${b.y},${b.width},${b.height}] px: ${o.pixels.length} sym: ${sym}`,
      );
    }
  }

  if (g.relations.length > 0) {
    lines.push("relations:");
    for (const rel of g.relations) {
      lines.push(`- ${rel.sourceId} ${rel.relation} ${rel.targetId}`);
    }
  }
  return lines.join("\n");
}
