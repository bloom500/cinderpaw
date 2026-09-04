/**
 * Cross-session dedup — Pathway 4 PR-C Task C.3.
 *
 * Collapses leaves whose cosine similarity >= mergeThreshold AND whose
 * `first_seen_at` differ by >= spanThresholdMs.  Runs AFTER the reconciler's
 * per-write cosine merge (step-2), which handles same-session near-dups.
 * This pass catches the same fact recorded across different sessions weeks
 * apart.
 *
 * Pure function — no I/O, no mutation of the LeafStore.  The caller
 * (FractalMemory.dedup()) removes the absorbed ids and emits the pulse.
 */

import { cosine } from "./cosine.ts";

/** A leaf enriched with its embedding vector — what dedup needs to compare. */
export interface DedupLeaf {
  id: number;
  text: string;
  first_seen_at: number;
  last_seen_at: number;
  hit_count: number;
  vec: number[];
}

/** A group of collapsed leaves: the survivor keeps its id + text + earliest
 *  first_seen_at; absorbed leaves are removed from the store. */
export interface DedupGroup {
  survivor: DedupLeaf;
  absorbed: DedupLeaf[];
}

interface DedupOpts {
  /** Minimum cosine similarity to consider two leaves duplicates (default 0.92). */
  mergeThreshold: number;
  /** Minimum span between first_seen_at values to collapse (default 30 days in ms). */
  spanThresholdMs: number;
  /** Current timestamp (ms since epoch). */
  now: number;
}

/** L2-normalize a Float32Array in place. */
function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

/**
 * Greedy grouping of near-duplicate leaves across sessions.
 *
 * For each ungrouped leaf, find all OTHER ungrouped leaves whose cosine >= threshold
 * AND |first_seen_at difference| >= spanThresholdMs.  The earliest leaf is the
 * survivor; later ones are absorbed.  Survivor's last_seen_at becomes the max
 * across the group; hit_count becomes the sum.
 */
export function dedupAcrossSessions(
  leaves: DedupLeaf[],
  opts: DedupOpts,
): DedupGroup[] {
  const { mergeThreshold, spanThresholdMs, now: _now } = opts;
  const groups: DedupGroup[] = [];
  const used = new Set<number>();

  // Pre-normalize all vectors once to avoid redundant L2 normalization in cosine.
  const normalized = leaves.map((l) => l2Normalize(new Float32Array(l.vec)));

  // Visit in first-seen order, oldest first, so the seed of every group is
  // also its survivor. Iterating in array order meant the seed was whatever
  // happened to be at that index: an older leaf discovered later got absorbed
  // into a younger one, and the group's own reduce then had to demote the seed
  // — which is how the seed ended up in `absorbed` and got deleted. Ties break
  // on id, so two runs over the same data group identically.
  const order = leaves
    .map((leaf, index) => ({ leaf, index }))
    .sort(
      (x, y) =>
        x.leaf.first_seen_at - y.leaf.first_seen_at || x.leaf.id - y.leaf.id,
    );

  for (const { leaf: a, index: i } of order) {
    if (used.has(a.id)) continue;

    const aVec = normalized[i]!;
    const absorbed: DedupLeaf[] = [];
    for (let j = 0; j < leaves.length; j++) {
      if (i === j) continue;
      const b = leaves[j]!;
      if (used.has(b.id)) continue;

      const span = Math.abs(a.first_seen_at - b.first_seen_at);
      if (span < spanThresholdMs) continue;

      const sim = cosine(aVec, normalized[j]!);
      if (sim >= mergeThreshold) {
        absorbed.push(b);
        used.add(b.id);
      }
    }

    if (absorbed.length > 0) {
      used.add(a.id);
      // Survivor = earliest first_seen_at among a + absorbed
      const all = [a, ...absorbed];
      const survivor = all.reduce((earliest, cur) =>
        cur.first_seen_at < earliest.first_seen_at ? cur : earliest,
      );
      const others = all.filter((l) => l.id !== survivor.id);
      groups.push({
        survivor: {
          ...survivor,
          last_seen_at: Math.max(...all.map((l) => l.last_seen_at)),
          hit_count: all.reduce((sum, l) => sum + l.hit_count, 0),
        },
        absorbed: others,
      });
    }
  }

  return groups;
}
