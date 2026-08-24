/**
 * Scene Graph Perception Module.
 *
 * Converts raw 2D numerical grids (or UI element bounding boxes) into
 * structured SceneGraphs consisting of SpatialObjects and SpatialRelations.
 *
 * Designed for:
 *  1. ARC-AGI 2D matrix transformation parsing.
 *  2. UIA desktop control element abstraction.
 */

import {
  BoundingBox,
  SceneGraph,
  ShapeCategory,
  SpatialObject,
  SpatialRelation,
  SpatialRelationType,
} from "../types/perception.js";

/**
 * Options for Connected Component Analysis (CCA).
 */
export interface ParseSceneGraphOptions {
  /** Background color value to ignore (default: 0). Pass null to treat 0 as an object. */
  backgroundColor?: number | string | null;
  /** Whether to use 8-connectivity (includes diagonals) or 4-connectivity (orthogonal only). Default: 8. */
  connectivity?: 4 | 8;
}

/**
 * Parses a 2D grid into a SceneGraph containing objects, shapes, symmetries, and spatial relations.
 */
export function parseSceneGraph(
  grid: Array<Array<number | string>>,
  options: ParseSceneGraphOptions = {}
): SceneGraph {
  const bg = options.backgroundColor !== undefined ? options.backgroundColor : 0;
  const connectivity = options.connectivity ?? 8;

  const rows = grid.length;
  if (rows === 0) {
    return {
      gridDimensions: { rows: 0, cols: 0 },
      objects: [],
      relations: [],
      dominantColors: [],
    };
  }
  const cols = grid[0].length;

  const visited: boolean[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(false)
  );

  const objects: SpatialObject[] = [];
  const colorCounts = new Map<number | string, number>();

  let objectCounter = 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const val = grid[r][c];

      // Track color counts for background as well
      colorCounts.set(val, (colorCounts.get(val) ?? 0) + 1);

      if (visited[r][c]) continue;
      if (bg !== null && val === bg) {
        visited[r][c] = true;
        continue;
      }

      // Flood fill / BFS for Connected Component
      const pixels: Array<[number, number]> = [];
      const queue: Array<[number, number]> = [[r, c]];
      visited[r][c] = true;

      while (queue.length > 0) {
        const [currR, currC] = queue.shift()!;
        pixels.push([currR, currC]);

        const neighbors = getNeighbors(currR, currC, rows, cols, connectivity);
        for (const [nR, nC] of neighbors) {
          if (!visited[nR][nC] && grid[nR][nC] === val) {
            visited[nR][nC] = true;
            queue.push([nR, nC]);
          }
        }
      }

      // Compute bounding box
      let minR = rows,
        maxR = -1,
        minC = cols,
        maxC = -1;
      for (const [pr, pc] of pixels) {
        if (pr < minR) minR = pr;
        if (pr > maxR) maxR = pr;
        if (pc < minC) minC = pc;
        if (pc > maxC) maxC = pc;
      }

      const bbox: BoundingBox = {
        x: minC,
        y: minR,
        width: maxC - minC + 1,
        height: maxR - minR + 1,
      };

      const shapeCat = categorizeShape(pixels, bbox);
      const symmetry = checkSymmetry(pixels, bbox);

      objects.push({
        id: `obj_${objectCounter++}`,
        color: val,
        pixelCount: pixels.length,
        boundingBox: bbox,
        pixels,
        shapeCategory: shapeCat,
        symmetry,
      });
    }
  }

  // Build spatial relations between object pairs
  const relations = computeSpatialRelations(objects);

  // Format dominant colors list
  const dominantColors = Array.from(colorCounts.entries())
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count);

  return {
    gridDimensions: { rows, cols },
    objects,
    relations,
    dominantColors,
  };
}

/**
 * Categorize shape based on geometry and fill density.
 */
function categorizeShape(
  pixels: Array<[number, number]>,
  bbox: BoundingBox
): ShapeCategory {
  if (pixels.length === 1) return "single_pixel";
  if (bbox.width === 1 || bbox.height === 1) return "line";

  const area = bbox.width * bbox.height;
  if (pixels.length === area) return "rectangle";

  // Check if it's a hollow frame
  if (
    bbox.width >= 3 &&
    bbox.height >= 3 &&
    pixels.length === 2 * bbox.width + 2 * bbox.height - 4
  ) {
    return "frame";
  }

  return "irregular";
}

/**
 * Check horizontal and vertical symmetry of an object within its bounding box.
 */
function checkSymmetry(
  pixels: Array<[number, number]>,
  bbox: BoundingBox
): { horizontal: boolean; vertical: boolean } {
  const pixelSet = new Set(pixels.map(([r, c]) => `${r},${c}`));

  let horizontal = true;
  let vertical = true;

  for (const [r, c] of pixels) {
    // Horizontal mirror (flip columns)
    const mirroredC = bbox.x + (bbox.x + bbox.width - 1 - c);
    if (!pixelSet.has(`${r},${mirroredC}`)) {
      horizontal = false;
    }

    // Vertical mirror (flip rows)
    const mirroredR = bbox.y + (bbox.y + bbox.height - 1 - r);
    if (!pixelSet.has(`${mirroredR},${c}`)) {
      vertical = false;
    }
  }

  return { horizontal, vertical };
}

/**
 * Compute spatial relations for all object pairs.
 */
function computeSpatialRelations(objects: SpatialObject[]): SpatialRelation[] {
  const relations: SpatialRelation[] = [];

  for (let i = 0; i < objects.length; i++) {
    for (let j = 0; j < objects.length; j++) {
      if (i === j) continue;

      const objA = objects[i];
      const objB = objects[j];

      // Inside / Bounding Box Containment
      if (
        objA.boundingBox.x >= objB.boundingBox.x &&
        objA.boundingBox.y >= objB.boundingBox.y &&
        objA.boundingBox.x + objA.boundingBox.width <=
          objB.boundingBox.x + objB.boundingBox.width &&
        objA.boundingBox.y + objA.boundingBox.height <=
          objB.boundingBox.y + objB.boundingBox.height
      ) {
        relations.push({
          sourceId: objA.id,
          targetId: objB.id,
          relation: "inside",
        });
      }

      // Larger than
      if (objA.pixelCount > objB.pixelCount) {
        relations.push({
          sourceId: objA.id,
          targetId: objB.id,
          relation: "larger_than",
        });
      }

      // Same color
      if (objA.color === objB.color) {
        relations.push({
          sourceId: objA.id,
          targetId: objB.id,
          relation: "same_color",
        });
      }

      // Aligned horizontally (Y bounding box overlap)
      const yOverlap =
        objA.boundingBox.y < objB.boundingBox.y + objB.boundingBox.height &&
        objA.boundingBox.y + objA.boundingBox.height > objB.boundingBox.y;
      if (yOverlap) {
        relations.push({
          sourceId: objA.id,
          targetId: objB.id,
          relation: "aligned_horizontally",
        });
      }

      // Aligned vertically (X bounding box overlap)
      const xOverlap =
        objA.boundingBox.x < objB.boundingBox.x + objB.boundingBox.width &&
        objA.boundingBox.x + objA.boundingBox.width > objB.boundingBox.x;
      if (xOverlap) {
        relations.push({
          sourceId: objA.id,
          targetId: objB.id,
          relation: "aligned_vertically",
        });
      }

      // Adjacency
      if (isAdjacent(objA.boundingBox, objB.boundingBox)) {
        relations.push({
          sourceId: objA.id,
          targetId: objB.id,
          relation: "adjacent",
        });
      }
    }
  }

  return relations;
}

function isAdjacent(a: BoundingBox, b: BoundingBox): boolean {
  const xOverlap =
    a.x < b.x + b.width && a.x + a.width > b.x;
  const yOverlap =
    a.y < b.y + b.height && a.y + a.height > b.y;

  const xTouch = a.x + a.width === b.x || b.x + b.width === a.x;
  const yTouch = a.y + a.height === b.y || b.y + b.height === a.y;

  return (xTouch && yOverlap) || (yTouch && xOverlap);
}

/**
 * Neighbor directions for 4-way or 8-way connectivity.
 */
function getNeighbors(
  r: number,
  c: number,
  rows: number,
  cols: number,
  connectivity: 4 | 8
): Array<[number, number]> {
  const dirs =
    connectivity === 4
      ? [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]
      : [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, -1],
          [-1, 1],
          [1, -1],
          [1, 1],
        ];

  const neighbors: Array<[number, number]> = [];
  for (const [dr, dc] of dirs) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
      neighbors.push([nr, nc]);
    }
  }
  return neighbors;
}

/**
 * Formats a SceneGraph into a compact, token-efficient YAML string representation for LLM context.
 */
export function formatSceneGraphToYaml(graph: SceneGraph): string {
  const lines: string[] = [];

  lines.push(`dimensions: ${graph.gridDimensions.rows}x${graph.gridDimensions.cols}`);
  lines.push(`objects_count: ${graph.objects.length}`);

  lines.push(`objects:`);
  for (const obj of graph.objects) {
    lines.push(`  - id: ${obj.id}`);
    lines.push(`    color: ${obj.color}`);
    lines.push(`    pixels: ${obj.pixelCount}`);
    lines.push(
      `    bbox: {x: ${obj.boundingBox.x}, y: ${obj.boundingBox.y}, w: ${obj.boundingBox.width}, h: ${obj.boundingBox.height}}`
    );
    lines.push(`    shape: ${obj.shapeCategory}`);
    lines.push(
      `    symmetry: {h: ${obj.symmetry.horizontal}, v: ${obj.symmetry.vertical}}`
    );
  }

  if (graph.relations.length > 0) {
    lines.push(`relations:`);
    for (const rel of graph.relations) {
      lines.push(`  - ${rel.sourceId} ${rel.relation} ${rel.targetId}`);
    }
  }

  return lines.join("\n");
}
