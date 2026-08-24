/**
 * Scene Graph Perception Contracts.
 *
 * Defines the structured types for converting raw 2D grid arrays or
 * unstructured UIA accessibility nodes into typed spatial object graphs.
 */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ShapeCategory =
  | "single_pixel"
  | "line"
  | "rectangle"
  | "frame"
  | "irregular";

export interface SpatialObject {
  id: string;
  color: number | string;
  pixelCount: number;
  boundingBox: BoundingBox;
  pixels: Array<[number, number]>; // [row, col]
  shapeCategory: ShapeCategory;
  symmetry: {
    horizontal: boolean;
    vertical: boolean;
  };
}

export type SpatialRelationType =
  | "inside"
  | "adjacent"
  | "aligned_horizontally"
  | "aligned_vertically"
  | "larger_than"
  | "same_color";

export interface SpatialRelation {
  sourceId: string;
  targetId: string;
  relation: SpatialRelationType;
}

export interface SceneGraph {
  gridDimensions: { rows: number; cols: number };
  objects: SpatialObject[];
  relations: SpatialRelation[];
  dominantColors: Array<{ color: number | string; count: number }>;
}
