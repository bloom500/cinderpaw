import type { ToolActivity } from '@/hooks/useLiveToolActivity';

/**
 * What Feral did during calls, kept after the widgets have faded.
 *
 * The panel is a live indicator: rows age out six seconds after they finish,
 * because a call screen showing everything that ever happened is a log, not an
 * indicator. But the useful part of a search is its SOURCES, and those were
 * being thrown away — the answer was spoken, the links vanished, and the only
 * way back to a page the agent read was to ask it again.
 *
 * Deliberately outside React, like `feralLiveSession`: this has to outlive the
 * overlay that produced it, and a hook's state does not survive hanging up.
 *
 * ponytail: memory only. Artefacts vanish on restart, which is the honest limit
 * of this version — surviving that needs somewhere on disk to put them, and
 * that is the same missing piece as the call's post-turn memory. Wire both at
 * once when it comes.
 */

/** How many are kept. Old enough to have scrolled past, few enough to stay a
 *  drawer rather than a database. */
const MAX = 40;

let artifacts: ToolActivity[] = [];
const listeners = new Set<() => void>();

/**
 * Replaced, never mutated in place.
 *
 * `useSyncExternalStore` compares snapshots by identity: an array pushed into
 * keeps the same reference, so React would see no change and never re-render.
 * A new array per write is the whole contract.
 */
function commit(next: ToolActivity[]): void {
  artifacts = next;
  for (const fn of listeners) fn();
}

/**
 * File a finished activity.
 *
 * Only finished ones, and only those that produced something worth returning
 * to: a `read_file` that reported a line count leaves nothing to click, and
 * filling the drawer with those buries the searches that do.
 */
export function recordArtifact(activity: ToolActivity): void {
  if (activity.status === 'running') return;
  const worthKeeping =
    activity.hits.length > 0 || activity.facts.length > 0 || activity.files.length > 0;
  if (!worthKeeping) return;
  // Same tool, same subject, already filed: the model re-asks the same question
  // several times in one call, and four identical searches in the drawer is
  // worse than one.
  const duplicate = artifacts.some(
    (a) => a.tool === activity.tool && a.subject === activity.subject,
  );
  if (duplicate) return;
  commit([activity, ...artifacts].slice(0, MAX));
}

export function clearArtifacts(): void {
  commit([]);
}

/** For `useSyncExternalStore`. Returns the unsubscribe. */
export function subscribeArtifacts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Newest first — the same order the panel shows. */
export function artifactsSnapshot(): ToolActivity[] {
  return artifacts;
}
