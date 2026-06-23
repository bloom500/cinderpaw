/**
 * LeafStore — Pathway 4 PR-C Task C.0.
 *
 * A durable, provenance-bearing store for reactively-captured fact leaves,
 * persisted to `<dataDir>/fractal-leaves.jsonl` (one JSON record per line).
 * Closes step-2's "reactive leaves in-memory only" gap: `FractalMemory.
 * upsertLeaf` writes through to this store so leaves survive restart and
 * carry the `last_seen_at` / `hit_count` provenance that eviction (C.1/C.2)
 * and cross-session dedup (C.3) read.
 *
 * Contract:
 *   - `":memory:"` (or an empty path) ⇒ pure in-memory, no disk I/O. Keeps
 *     step-2 fixtures and unit tests fast and hermetic.
 *   - Mutations persist via an ATOMIC full rewrite (`<path>.tmp` + rename).
 *     Full rewrite (not append) because records are updated in place on a
 *     merge; the store stays bounded by eviction (≤ FERAL_FMS_MAX_LEAVES).
 *   - `load()` is tolerant of corrupt lines — a bad line is skipped and
 *     counted, never throws (a partially-written file must not crash boot).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** The single source of truth for the store's filename. */
export const LEAF_STORE_FILENAME = "fractal-leaves.jsonl";

/** A durable leaf record. `vec` is `number[]` (not Float32Array) so it
 *  serialises cleanly to JSON; callers convert at the boundary. */
export interface LeafRecord {
  id: number;
  text: string;
  vec: number[];
  ts: number;
  sessionId: string;
  provenance: {
    source: string;
    first_seen_at: number;
    last_seen_at: number;
    hit_count: number;
    key?: string;
    value?: string;
  };
}

/** The provenance-bearing projection eviction (C.1/C.2) and dedup (C.3)
 *  operate on as pure functions. */
export interface LeafSummary {
  id: number;
  text: string;
  first_seen_at: number;
  last_seen_at: number;
  hit_count: number;
}

export class LeafStore {
  readonly #path: string;
  readonly #inMemory: boolean;
  readonly #records = new Map<number, LeafRecord>();

  constructor(path: string) {
    this.#path = path;
    this.#inMemory = path === ":memory:" || path === "";
  }

  /** Load records from disk into memory. Returns counts; corrupt lines are
   *  skipped, never fatal. A no-op for the in-memory store or a missing file. */
  load(): { loaded: number; skipped: number } {
    this.#records.clear();
    if (this.#inMemory || !existsSync(this.#path)) return { loaded: 0, skipped: 0 };
    let loaded = 0;
    let skipped = 0;
    const raw = readFileSync(this.#path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as LeafRecord;
        if (rec && typeof rec.id === "number" && rec.provenance) {
          this.#records.set(rec.id, rec);
          loaded++;
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
    }
    return { loaded, skipped };
  }

  /** Insert or replace a record by id, then persist. */
  upsert(rec: LeafRecord): void {
    this.#records.set(rec.id, rec);
    this.#persist();
  }

  /** Drop the given ids and persist (only when something changed). */
  remove(ids: number[]): void {
    let changed = false;
    for (const id of ids) changed = this.#records.delete(id) || changed;
    if (changed) this.#persist();
  }

  /** All records (insertion order). */
  all(): LeafRecord[] {
    return [...this.#records.values()];
  }

  /** Provenance-bearing summaries for eviction / dedup. */
  summaries(): LeafSummary[] {
    return this.all().map((r) => ({
      id: r.id,
      text: r.text,
      first_seen_at: r.provenance.first_seen_at,
      last_seen_at: r.provenance.last_seen_at,
      hit_count: r.provenance.hit_count,
    }));
  }

  /** Atomic full rewrite: write `<path>.tmp` then rename over `<path>`. */
  #persist(): void {
    if (this.#inMemory) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    const body = this.all().map((r) => JSON.stringify(r)).join("\n");
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, body.length ? body + "\n" : "", "utf8");
    renameSync(tmp, this.#path);
  }
}
