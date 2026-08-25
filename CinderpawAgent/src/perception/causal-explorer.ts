/**
 * causal-explorer.ts — Causal Exploration for interactive ARC-AGI-3 worlds.
 *
 * Compares two SceneGraph snapshots (before/after one executed action) and
 * distills what the action actually changed into a reusable CausalRule.
 * This is the world-model's induction step: "when I do ACTION3, THIS object
 * changes THAT property". Pure and synchronous — no I/O, no mutation of
 * the input graphs.
 */

import type { SceneGraph, SpatialObject } from "../types/perception.ts";

/** The action whose effect is being explained. */
export type ExecutedAction = string | { name: string; params?: Record<string, unknown> };

export type TrackedProperty =
  | "existence"
  | "color"
  | "position"
  | "size"
  | "shapeCategory"
  | "symmetry"
  | "pixelPattern";

export interface PropertyChange {
  objectId: string;
  property: TrackedProperty;
  before: unknown;
  after: unknown;
}

export interface CausalRule {
  /** Normalized action name (e.g. "ACTION3"). */
  action: string;
  /** Ids of every object whose state moved between the two snapshots. */
  affectedObjects: string[];
  propertyChange: PropertyChange[];
}

/** Shared structural check — also used by the goal backward planner. */
export function assertSceneGraph(graph: unknown, label: string): asserts graph is SceneGraph {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error(`detectCausalDiff: ${label} must be a SceneGraph object`);
  }
  const g = graph as Partial<SceneGraph>;
  if (
    !g.gridDimensions ||
    typeof g.gridDimensions.rows !== "number" ||
    typeof g.gridDimensions.cols !== "number" ||
    !Array.isArray(g.objects)
  ) {
    throw new Error(
      `detectCausalDiff: ${label} is not a valid SceneGraph — expected { gridDimensions: { rows, cols }, objects: [...] }`,
    );
  }
}

function normalizeAction(actionExecuted: ExecutedAction): string {
  if (typeof actionExecuted === "string") {
    if (actionExecuted.trim() === "") {
      throw new Error("detectCausalDiff: actionExecuted must be a non-empty action name");
    }
    return actionExecuted;
  }
  if (actionExecuted && typeof actionExecuted.name === "string" && actionExecuted.name.trim() !== "") {
    return actionExecuted.name;
  }
  throw new Error(
    "detectCausalDiff: actionExecuted must be a non-empty string or { name: string, params? } — got neither",
  );
}

const bboxesEqual = (a: SpatialObject["boundingBox"], b: SpatialObject["boundingBox"]): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const symmetryEqual = (a: SpatialObject["symmetry"], b: SpatialObject["symmetry"]): boolean =>
  a.horizontal === b.horizontal && a.vertical === b.vertical && a.diagonal === b.diagonal;

const pixelsEqual = (a: SpatialObject["pixels"], b: SpatialObject["pixels"]): boolean => {
  if (a.length !== b.length) return false;
  const norm = (px: Array<[number, number]>) =>
    px.map(([r, c]) => `${r},${c}`).sort().join(";");
  return norm(a) === norm(b);
};

function diffObject(beforeObj: SpatialObject, afterObj: SpatialObject): PropertyChange[] {
  const changes: PropertyChange[] = [];
  const record = (property: TrackedProperty, before: unknown, after: unknown) =>
    changes.push({ objectId: beforeObj.id, property, before, after });

  if (beforeObj.color !== afterObj.color) record("color", beforeObj.color, afterObj.color);
  if (!bboxesEqual(beforeObj.boundingBox, afterObj.boundingBox)) {
    record(
      "position",
      { x: beforeObj.boundingBox.x, y: beforeObj.boundingBox.y },
      { x: afterObj.boundingBox.x, y: afterObj.boundingBox.y },
    );
    record("size", { w: beforeObj.boundingBox.width, h: beforeObj.boundingBox.height },
      { w: afterObj.boundingBox.width, h: afterObj.boundingBox.height });
  }
  if (beforeObj.shapeCategory !== afterObj.shapeCategory) {
    record("shapeCategory", beforeObj.shapeCategory, afterObj.shapeCategory);
  }
  if (!symmetryEqual(beforeObj.symmetry, afterObj.symmetry)) {
    record("symmetry", { ...beforeObj.symmetry }, { ...afterObj.symmetry });
  }
  if (!pixelsEqual(beforeObj.pixels, afterObj.pixels)) {
    record("pixelPattern", beforeObj.pixels.length, afterObj.pixels.length);
  }
  return changes;
}

/**
 * Diff two snapshots taken around one executed action and return the causal
 * rule describing exactly which objects moved/changed how. Deterministic:
 * affectedObjects sorted lexicographically, per-object properties reported
 * in a fixed order (color → position → size → shapeCategory → symmetry →
 * pixelPattern), creation/deletion reported as existence changes.
 */
export function detectCausalDiff(
  beforeGraph: SceneGraph,
  afterGraph: SceneGraph,
  actionExecuted: ExecutedAction,
): CausalRule {
  assertSceneGraph(beforeGraph, "beforeGraph");
  assertSceneGraph(afterGraph, "afterGraph");
  const action = normalizeAction(actionExecuted);

  const beforeById = new Map(beforeGraph.objects.map((o) => [o.id, o]));
  const afterById = new Map(afterGraph.objects.map((o) => [o.id, o]));

  const changes: PropertyChange[] = [];
  const affected = new Set<string>();

  for (const [id, beforeObj] of beforeById) {
    const afterObj = afterById.get(id);
    if (!afterObj) {
      affected.add(id);
      changes.push({ objectId: id, property: "existence", before: "present", after: "absent" });
      continue;
    }
    for (const change of diffObject(beforeObj, afterObj)) {
      affected.add(id);
      changes.push(change);
    }
  }
  for (const [id] of afterById) {
    if (!beforeById.has(id)) {
      affected.add(id);
      changes.push({ objectId: id, property: "existence", before: "absent", after: "present" });
    }
  }

  return {
    action,
    affectedObjects: [...affected].sort(),
    propertyChange: changes,
  };
}
