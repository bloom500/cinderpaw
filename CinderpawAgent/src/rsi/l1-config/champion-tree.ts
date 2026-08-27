/**
 * Tree of Champions (BRSI §4.3 / §7.4) — per-niche champion archive.
 *
 * The single global champion (`champion.ts`) keeps only the best config the
 * engine ever ratcheted. That throws away DIVERSITY: a config that is the best
 * in a distinct behavioural region — high-temperature/graph-retrieval, say —
 * is erased the moment a different region produces a higher global score, even
 * though it was the winner for its own region. The Tree of Champions preserves
 * one champion PER niche so that diversity survives.
 *
 * ── Niche = behavioural region, not task domain ─────────────────────────────
 * The niche key is the escape-time `regionKey(config)` (`t:c:r:d` — temperature
 * / context / retrieval-strategy / depth buckets), the region key the engine
 * already uses for zoom decisions. That is the species precursor that EXISTS in
 * Faza 1. The user-facing "research vs coding" species (D1) is a task-DOMAIN
 * split that needs multi-domain evals + a query classifier (Faza 2+); this tree
 * is keyed on behaviour, and the domain label layers on top later.
 *
 * ── Bounding (D8) ───────────────────────────────────────────────────────────
 * One champion per niche (the best score seen in that niche). The number of
 * niches is capped (default 20) with least-recently-updated eviction, so a long
 * run can't grow the tree without bound. D8's "20 per species" is read here as
 * the niche cap; a within-niche elite archive (keep the top-N per niche) is a
 * future refinement, noted not built.
 *
 * Pure + deterministic (no clock, no fs beyond the explicit read/write
 * helpers), matching the rest of the rsi/ module discipline.
 */
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { dirname, join } from "node:path";
import { cinderpawHome } from "../../config.ts";
import type { ChampionRecord } from "./champion.ts";
import { regionKey } from "./escape-time.ts";
import type { GenomeConfig } from "./genome.ts";

/** The niche a config belongs to — its escape-time behavioural region. Re-
 *  exported through here so callers depend on the Tree's vocabulary, not the
 *  escape-time internals. */
export function nicheOf(config: GenomeConfig): string {
  return regionKey(config);
}

/** One niche's reigning champion. */
export interface NicheChampion {
  niche: string;
  champion: ChampionRecord;
}

/** Serialisable snapshot of the tree (its own version, independent of the
 *  population snapshot — deliberately NOT folded into SNAPSHOT_VERSION so this
 *  never touches the v1→v2 population-snapshot migration). */
export interface ChampionTreeState {
  version: 1;
  niches: NicheChampion[];
}

/** Default cap on tracked niches (D8). */
const DEFAULT_MAX_NICHES = 20;

/**
 * A map of niche → best champion in that niche, bounded by an LRU cap on the
 * niche count. Insertion order in the backing Map is the recency order: a
 * niche is moved to the end each time its champion is updated, so the first key
 * is always the least-recently-updated (the eviction target).
 */
export class SpeciesChampions {
  private readonly map = new Map<string, ChampionRecord>();

  constructor(private readonly maxNiches: number = DEFAULT_MAX_NICHES) {}

  /**
   * Offer a candidate for its niche. It becomes (or replaces) the niche
   * champion only if it strictly beats the incumbent's score — the same
   * strict-greater discipline as the ratchet (I1), so ties don't churn. On a
   * successful record the niche is bumped to most-recently-updated and, if the
   * niche count now exceeds the cap, the least-recently-updated niche is
   * evicted. Returns true iff the candidate was recorded.
   */
  record(niche: string, candidate: ChampionRecord): boolean {
    const existing = this.map.get(niche);
    if (existing && candidate.score <= existing.score) return false;
    // Re-insert to move the niche to the end (most-recently-updated).
    this.map.delete(niche);
    this.map.set(niche, candidate);
    while (this.map.size > this.maxNiches) {
      const lru = this.map.keys().next().value as string | undefined;
      if (lru === undefined) break;
      this.map.delete(lru);
    }
    return true;
  }

  /** The reigning champion of a niche, if any. */
  get(niche: string): ChampionRecord | undefined {
    return this.map.get(niche);
  }

  /** The single best champion across all niches (the global best) — the value
   *  `champion.ts` tracks alone. Undefined when the tree is empty. */
  best(): ChampionRecord | undefined {
    let best: ChampionRecord | undefined;
    for (const rec of this.map.values()) {
      if (!best || rec.score > best.score) best = rec;
    }
    return best;
  }

  /** All niche champions, least-recently-updated first. */
  all(): NicheChampion[] {
    return [...this.map.entries()].map(([niche, champion]) => ({ niche, champion }));
  }

  /** How many niches currently hold a champion. */
  size(): number {
    return this.map.size;
  }

  /** Serialise for persistence. */
  toState(): ChampionTreeState {
    return { version: 1, niches: this.all() };
  }

  /** Rebuild from a persisted snapshot. Records are re-inserted in order, so
   *  recency + the niche cap are re-applied (a snapshot larger than the cap is
   *  trimmed to the most-recent `maxNiches`). Malformed entries are skipped. */
  static fromState(state: ChampionTreeState | null, maxNiches: number = DEFAULT_MAX_NICHES): SpeciesChampions {
    const tree = new SpeciesChampions(maxNiches);
    if (!state || !Array.isArray(state.niches)) return tree;
    for (const n of state.niches) {
      if (n && typeof n.niche === "string" && n.champion && typeof n.champion.score === "number") {
        // Bypass the strict-greater guard on load — the snapshot already holds
        // the winners; we're restoring, not competing.
        tree.map.set(n.niche, n.champion);
        while (tree.map.size > maxNiches) {
          const lru = tree.map.keys().next().value as string | undefined;
          if (lru === undefined) break;
          tree.map.delete(lru);
        }
      }
    }
    return tree;
  }
}

/** Default on-disk location, sibling of `champion.json`. */
export function defaultChampionTreePath(): string {
  return join(cinderpawHome(), "rsi", "champion-tree.json");
}

/** Persist the tree. Best-effort mkdir; throws only on a genuine write fault
 *  (the caller wraps it — a persistence failure must not abort the engine). */
export function writeChampionTree(path: string, tree: SpeciesChampions): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(tree.toState(), null, 2));
}

/** Load the tree. Missing / corrupt file → an empty tree (never throws — a bad
 *  tree file must not crash the engine boot). */
export function readChampionTree(path: string, maxNiches: number = DEFAULT_MAX_NICHES): SpeciesChampions {
  try {
    if (!existsSync(path)) return new SpeciesChampions(maxNiches);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ChampionTreeState;
    return SpeciesChampions.fromState(parsed, maxNiches);
  } catch {
    return new SpeciesChampions(maxNiches);
  }
}
