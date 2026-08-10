/**
 * How much a file write actually changed, in lines — the "+71" half of a
 * telemetry line the user reads after the fact.
 *
 * Lives here rather than in either tool because `write_file` and `edit_file`
 * must report the SAME number for the same change. Two counters that disagree
 * turn a trace into a thing you have to double-check, which is worse than no
 * trace at all.
 */

import { relative, isAbsolute } from "node:path";
import { scratchRoot } from "../config.ts";

export interface LineDelta {
  added: number;
  removed: number;
}

/**
 * Lines added and removed between two versions of a file.
 *
 * ponytail: multiset difference, not a real LCS diff. Costs one pass and no
 * dependency, and it is exactly right for the case this serves — an agent
 * appending to and rewriting its own scratch notes. The known ceiling: a line
 * MOVED within the file appears in both multisets and so counts as neither
 * added nor removed. For a "how much changed" indicator that is the answer you
 * want; if this ever has to render a real diff view, swap in a proper LCS here
 * and nothing else has to change.
 */
export function lineDelta(before: string, after: string): LineDelta {
  if (before === after) return { added: 0, removed: 0 };

  // An empty file has ZERO lines, not one empty line. Without this, creating a
  // 71-line file reported "+71 −1" — the phantom removal being the empty string
  // `"".split("\n")` hands back.
  const lines = (s: string): string[] => (s === "" ? [] : s.split("\n"));

  const counts = new Map<string, number>();
  // Positive = present in `before`, negative = present in `after`. One map, one
  // pass each way; whatever is left over is the change.
  for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of lines(after)) counts.set(line, (counts.get(line) ?? 0) - 1);

  let added = 0;
  let removed = 0;
  for (const n of counts.values()) {
    if (n < 0) added += -n;
    else removed += n;
  }
  return { added, removed };
}

/**
 * Is this path inside the agent's own scratch directory?
 *
 * The distinction is the whole point of the telemetry: "3 scratchpad edits" is
 * the agent thinking out loud and needs no review, while "3 edits" in the
 * user's project is something they may want to look at. Rendering both the same
 * way trains people to ignore the line.
 *
 * `relative` rather than `startsWith`: a sibling directory whose name merely
 * begins with the root's ("…/workspace-old") is not inside it.
 */
export function isScratchPath(absolutePath: string): boolean {
  const rel = relative(scratchRoot(), absolutePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
