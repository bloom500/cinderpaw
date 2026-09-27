/**
 * Forgetting a fact, on every copy of it.
 *
 * A mined fact lives in three places: SemanticMemory (`key: value`, injected
 * every turn as "Known facts"), the knowledge graph (`key —has→ value`,
 * rendered as "facts learned about the user"), and a fractal leaf (recalled
 * by similarity). Each forget path used to clear one of them: the `remember`
 * tool deleted the semantic row, the memory page's Forget deleted the graph
 * edge, and the fact kept coming back through the others.
 *
 * Only global (owner) facts are mirrored into the graph and the tree (see
 * extractor.ts and reconciler.ts), so only they have mirrors to clear.
 */
import type { MemoryGraph } from "./graph.ts";
import type { SemanticMemory } from "./semantic.ts";

export interface ForgetTargets {
  graph: MemoryGraph;
  semantic: SemanticMemory;
  fractal: { forgetFact(key: string): number[] };
}

/** After SemanticMemory.delete(key): clear the graph edge and the tree leaf. */
export function forgetMirrors(t: ForgetTargets, key: string): void {
  if (t.graph.forgetFact(key, "has") > 0) t.graph.persist();
  t.fractal.forgetFact(key);
}

/**
 * The memory page's Forget on one graph edge. When the edge is a mirrored fact
 * (`key —has→ value`) and SemanticMemory still holds that value for the key,
 * the fact goes too, with its leaf; a newer value the page was not showing is
 * left alone. Returns how many edges were removed.
 */
export function forgetEdge(t: ForgetTargets, edge: { from: string; to: string; relation?: string }): number {
  const nodes = t.graph.snapshot().nodes;
  const key = nodes[edge.from]?.label;
  const value = nodes[edge.to]?.label;
  const removed = t.graph.removeEdge(edge.from, edge.to, edge.relation || undefined);
  if (removed > 0) t.graph.persist();
  if (key && value && (!edge.relation || edge.relation === "has")) {
    const current = t.semantic.get(key);
    if (current && current.value.trim().toLowerCase() === value.trim().toLowerCase()) {
      t.semantic.delete(key);
      t.fractal.forgetFact(key);
    }
  }
  return removed;
}
