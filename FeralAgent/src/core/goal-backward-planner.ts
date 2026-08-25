/**
 * Goal Backward Planner (Backward Chaining Engine).
 *
 * Compares target goal state with current state and produces an inverted chain of sub-goals
 * (create -> recolor -> move -> resize) with explicit prerequisites.
 */

import { SceneGraph, SpatialObject } from "../types/perception.js";

export type SubGoalType = "create" | "recolor" | "move" | "resize" | "remove";

export interface SubGoal {
  id: string;
  type: SubGoalType;
  targetObjectId: string;
  dependsOn: string[];
  description: string;
  params: Record<string, any>;
}

export interface BackwardPlan {
  goals: SubGoal[];
  executableOrder: SubGoal[];
}

/**
 * Plans backward from goal target graph comparing against current graph.
 */
export function planBackwardFromGoal(
  currentGraph: SceneGraph,
  targetGraph: SceneGraph
): BackwardPlan {
  const goals: SubGoal[] = [];

  const currentMap = new Map<string, SpatialObject>(
    currentGraph.objects.map((o) => [o.id, o])
  );
  const targetMap = new Map<string, SpatialObject>(
    targetGraph.objects.map((o) => [o.id, o])
  );

  let subGoalCounter = 1;

  // Check objects that exist in target
  for (const [id, targetObj] of targetMap.entries()) {
    const currentObj = currentMap.get(id);

    if (!currentObj) {
      // Must create object first
      const createGoalId = `goal_${subGoalCounter++}`;
      goals.push({
        id: createGoalId,
        type: "create",
        targetObjectId: id,
        dependsOn: [],
        description: `Create object ${id} at color ${targetObj.color}`,
        params: { color: targetObj.color, bbox: targetObj.boundingBox },
      });

      // If created, check if it needs repositioning or recoloring as dependent sub-goals
      if (
        targetObj.boundingBox.x !== 0 ||
        targetObj.boundingBox.y !== 0
      ) {
        goals.push({
          id: `goal_${subGoalCounter++}`,
          type: "move",
          targetObjectId: id,
          dependsOn: [createGoalId],
          description: `Move created object ${id} to (${targetObj.boundingBox.x}, ${targetObj.boundingBox.y})`,
          params: { x: targetObj.boundingBox.x, y: targetObj.boundingBox.y },
        });
      }
      continue;
    }

    // Object exists, check if recolor needed
    if (currentObj.color !== targetObj.color) {
      goals.push({
        id: `goal_${subGoalCounter++}`,
        type: "recolor",
        targetObjectId: id,
        dependsOn: [],
        description: `Recolor object ${id} from ${currentObj.color} to ${targetObj.color}`,
        params: { fromColor: currentObj.color, toColor: targetObj.color },
      });
    }

    // Check if move needed
    if (
      currentObj.boundingBox.x !== targetObj.boundingBox.x ||
      currentObj.boundingBox.y !== targetObj.boundingBox.y
    ) {
      goals.push({
        id: `goal_${subGoalCounter++}`,
        type: "move",
        targetObjectId: id,
        dependsOn: [],
        description: `Move object ${id} to (${targetObj.boundingBox.x}, ${targetObj.boundingBox.y})`,
        params: { x: targetObj.boundingBox.x, y: targetObj.boundingBox.y },
      });
    }
  }

  // Check objects in current that should be removed in target
  for (const [id, currentObj] of currentMap.entries()) {
    if (!targetMap.has(id)) {
      goals.push({
        id: `goal_${subGoalCounter++}`,
        type: "remove",
        targetObjectId: id,
        dependsOn: [],
        description: `Remove object ${id}`,
        params: {},
      });
    }
  }

  // Sort executable order by dependencies
  const executableOrder = [...goals].sort(
    (a, b) => a.dependsOn.length - b.dependsOn.length
  );

  return {
    goals,
    executableOrder,
  };
}
