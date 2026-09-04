/**
 * goal-backward-planner.ts — Backward chaining from the victory image.
 *
 * Given the TARGET state (what winning looks like) and the CURRENT state,
 * derive the inverse dependency list of sub-goals that must be satisfied,
 * in execution order: every sub-goal's `dependsOn` entries reference
 * strictly EARLIER items of the returned array, so a planner can consume
 * the list front-to-back while the reasoning stays goal-first.
 *
 * Per-object transform chain (fixed order, deterministic):
 *   create → recolor → move → resize ; removals are independent.
 * Objects already equal to their target produce no sub-goal.
 */

import type { SceneGraph } from "../types/perception.ts";
import { assertSceneGraph } from "../perception/causal-explorer.ts";

export type SubGoalKind = "create" | "remove" | "recolor" | "move" | "resize";

export interface SubGoal {
  /** Stable id, e.g. "create:a1" or "recolor:b2". */
  id: string;
  kind: SubGoalKind;
  objectId: string;
  description: string;
  /** Ids of sub-goals that must complete BEFORE this one (earlier indices). */
  dependsOn: string[];
}

/**
 * Compare the current world against the victory image and return the
 * backward-chained sub-goal plan. Deterministic: object ids sorted
 * lexicographically, fixed property order within each chain.
 */
export function planBackwardFromGoal(targetGraph: SceneGraph, currentGraph: SceneGraph): SubGoal[] {
  assertSceneGraph(targetGraph, "targetGraph");
  assertSceneGraph(currentGraph, "currentGraph");

  const targetById = new Map(targetGraph.objects.map((o) => [o.id, o]));
  const currentById = new Map(currentGraph.objects.map((o) => [o.id, o]));

  const goals: SubGoal[] = [];

  // Goal-side pass (backward chaining root): what the victory image needs.
  for (const id of [...targetById.keys()].sort()) {
    const targetObj = targetById.get(id)!;
    const currentObj = currentById.get(id);

    if (!currentObj) {
      goals.push({
        id: `create:${id}`,
        kind: "create",
        objectId: id,
        description: `create object ${id} with color ${JSON.stringify(targetObj.color)} at (${targetObj.boundingBox.x},${targetObj.boundingBox.y})`,
        dependsOn: [],
      });
      continue;
    }

    let latestDeps: string[] = [];
    if (currentObj.color !== targetObj.color) {
      goals.push({
        id: `recolor:${id}`,
        kind: "recolor",
        objectId: id,
        description: `recolor ${id}: ${JSON.stringify(currentObj.color)} → ${JSON.stringify(targetObj.color)}`,
        dependsOn: latestDeps,
      });
      latestDeps = [`recolor:${id}`];
    }
    if (
      currentObj.boundingBox.x !== targetObj.boundingBox.x ||
      currentObj.boundingBox.y !== targetObj.boundingBox.y
    ) {
      goals.push({
        id: `move:${id}`,
        kind: "move",
        objectId: id,
        description: `move ${id} to (${targetObj.boundingBox.x},${targetObj.boundingBox.y})`,
        dependsOn: latestDeps,
      });
      latestDeps = [`move:${id}`];
    }
    if (
      currentObj.boundingBox.width !== targetObj.boundingBox.width ||
      currentObj.boundingBox.height !== targetObj.boundingBox.height
    ) {
      goals.push({
        id: `resize:${id}`,
        kind: "resize",
        objectId: id,
        description: `resize ${id} to ${targetObj.boundingBox.width}x${targetObj.boundingBox.height}`,
        dependsOn: latestDeps,
      });
    }
  }

  // World-side pass: objects the victory image does NOT contain.
  for (const id of [...currentById.keys()].sort()) {
    if (!targetById.has(id)) {
      goals.push({
        id: `remove:${id}`,
        kind: "remove",
        objectId: id,
        description: `remove object ${id} — absent from the victory image`,
        dependsOn: [],
      });
    }
  }

  return goals;
}
