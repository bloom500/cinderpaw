/**
 * Causal Explorer Module.
 *
 * Analyzes changes between two consecutive SceneGraphs before and after an action
 * to derive a deterministic CausalRule describing the effect of the action.
 */

import { SceneGraph, SpatialObject } from "../types/perception.js";

export interface PropertyChange {
  type:
    | "position"
    | "color"
    | "shape"
    | "symmetry"
    | "pixel_pattern"
    | "existence";
  objectId: string;
  beforeValue?: any;
  afterValue?: any;
  description: string;
}

export interface CausalRule {
  action: string;
  affectedObjectIds: string[];
  propertyChanges: PropertyChange[];
  summary: string;
}

/**
 * Detects causal differences between before/after SceneGraphs given an executed action.
 */
export function detectCausalDiff(
  beforeGraph: SceneGraph,
  afterGraph: SceneGraph,
  actionExecuted: string
): CausalRule {
  const propertyChanges: PropertyChange[] = [];
  const affectedObjectIds = new Set<string>();

  const beforeMap = new Map<string, SpatialObject>(
    beforeGraph.objects.map((o) => [o.id, o])
  );
  const afterMap = new Map<string, SpatialObject>(
    afterGraph.objects.map((o) => [o.id, o])
  );

  // Check for deleted or modified objects from before -> after
  for (const [id, beforeObj] of beforeMap.entries()) {
    const afterObj = afterMap.get(id);

    if (!afterObj) {
      affectedObjectIds.add(id);
      propertyChanges.push({
        type: "existence",
        objectId: id,
        beforeValue: "present",
        afterValue: "deleted",
        description: `Object ${id} was deleted/removed`,
      });
      continue;
    }

    // Check position change
    if (
      beforeObj.boundingBox.x !== afterObj.boundingBox.x ||
      beforeObj.boundingBox.y !== afterObj.boundingBox.y
    ) {
      affectedObjectIds.add(id);
      propertyChanges.push({
        type: "position",
        objectId: id,
        beforeValue: { x: beforeObj.boundingBox.x, y: beforeObj.boundingBox.y },
        afterValue: { x: afterObj.boundingBox.x, y: afterObj.boundingBox.y },
        description: `Object ${id} moved from (${beforeObj.boundingBox.x}, ${beforeObj.boundingBox.y}) to (${afterObj.boundingBox.x}, ${afterObj.boundingBox.y})`,
      });
    }

    // Check color change
    if (beforeObj.color !== afterObj.color) {
      affectedObjectIds.add(id);
      propertyChanges.push({
        type: "color",
        objectId: id,
        beforeValue: beforeObj.color,
        afterValue: afterObj.color,
        description: `Object ${id} recolored from ${beforeObj.color} to ${afterObj.color}`,
      });
    }

    // Check shape change
    if (beforeObj.shapeCategory !== afterObj.shapeCategory) {
      affectedObjectIds.add(id);
      propertyChanges.push({
        type: "shape",
        objectId: id,
        beforeValue: beforeObj.shapeCategory,
        afterValue: afterObj.shapeCategory,
        description: `Object ${id} shape changed from ${beforeObj.shapeCategory} to ${afterObj.shapeCategory}`,
      });
    }
  }

  // Check for newly created objects
  for (const [id, afterObj] of afterMap.entries()) {
    if (!beforeMap.has(id)) {
      affectedObjectIds.add(id);
      propertyChanges.push({
        type: "existence",
        objectId: id,
        beforeValue: "absent",
        afterValue: "created",
        description: `New object ${id} created at (${afterObj.boundingBox.x}, ${afterObj.boundingBox.y})`,
      });
    }
  }

  const affectedList = Array.from(affectedObjectIds);
  const summary =
    affectedList.length === 0
      ? `Action "${actionExecuted}" produced no state changes.`
      : `Action "${actionExecuted}" affected ${
          affectedList.length
        } object(s): ${propertyChanges.map((p) => p.description).join("; ")}`;

  return {
    action: actionExecuted,
    affectedObjectIds: affectedList,
    propertyChanges,
    summary,
  };
}
