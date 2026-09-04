/**
 * perception.ts — typed object representations for 2D grids (ARC-AGI style).
 *
 * Schema copied verbatim from docs/cinderpaw-agi-harness-spec.md §Module 1.
 * Pure type layer only; the parser lives in
 * src/research/perception/scene-graph.ts.
 */

export interface SpatialObject {
  id: string;
  color: number | string;
  boundingBox: { x: number; y: number; width: number; height: number };
  pixels: Array<[number, number]>; // [row, col]
  shapeCategory: 'rectangle' | 'line' | 'single_pixel' | 'irregular' | 'frame';
  symmetry: { horizontal: boolean; vertical: boolean; diagonal: boolean };
}

export interface SpatialRelation {
  sourceId: string;
  targetId: string;
  relation: 'inside' | 'adjacent' | 'aligned_horizontally' | 'aligned_vertically' | 'same_color' | 'larger_than';
}

export interface SceneGraph {
  gridDimensions: { rows: number; cols: number };
  objects: SpatialObject[];
  relations: SpatialRelation[];
  dominantColors: Array<{ color: number | string; count: number }>;
}
