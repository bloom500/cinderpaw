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
 * They survive a restart too, because the point was always to come back to a
 * page days later and an in-memory drawer cannot do that.
 *
 * ponytail: `localStorage`, not a file or a table. These are titles and URLs —
 * a few kilobytes at the cap — and the app already keeps its UI state there, so
 * this adds a key rather than a storage layer. Move it to disk when someone
 * wants artefacts shared between machines, which is a different feature.
 */

/** How many are kept. Old enough to have scrolled past, few enough to stay a
 *  drawer rather than a database. */
const MAX = 40;

const KEY = 'feral-call-artifacts';

/**
 * Read what previous sessions left.
 *
 * Everything here is defensive on purpose: the stored shape is last week's
 * version of a type that keeps changing, and a call overlay that throws on
 * startup because an old record is missing a field is a far worse bug than a
 * drawer that came back empty.
 */
function load(): ToolActivity[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a): a is ToolActivity => !!a && typeof a === 'object' && 'tool' in a)
      .slice(0, MAX)
      // Fields added after something was written come back undefined, and every
      // consumer indexes them without checking. Filled in here, once, rather
      // than guarded at each of the six places that read them.
      .map((a) => ({
        ...a,
        hits: a.hits ?? [],
        files: a.files ?? [],
        facts: a.facts ?? [],
        output: a.output ?? '',
        cwd: a.cwd ?? '',
      }));
  } catch {
    return [];
  }
}

let artifacts: ToolActivity[] = load();
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
  // Written synchronously with the change rather than on unload: a desktop app
  // is closed by killing the window, and `beforeunload` is the handler that does
  // not run when it matters. At this size the write is cheaper than the risk.
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota, private mode, a disabled store — the drawer still works for this
    // session, and losing persistence must never break the call it belongs to.
  }
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
