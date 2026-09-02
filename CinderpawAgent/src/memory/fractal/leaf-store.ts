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
 *   - Mutations APPEND one line each; `load()` replays the log with
 *     later-wins semantics and tombstones for removals. The file is
 *     compacted by an atomic full rewrite once the log outgrows the live
 *     set. It used to rewrite everything on every mutation, which made the
 *     cost of remembering one fact scale with everything already remembered.
 *   - `CINDERPAW_FMS_MAX_LEAVES` is a hard ceiling on the live set, enforced
 *     here. It is a backstop, not a policy: the eviction policy decides what
 *     is STALE, this decides how many rows may exist at all. Before, the
 *     variable was registered in config and documented as a cap while
 *     nothing in the codebase read it.
 *   - `load()` is tolerant of corrupt lines — a bad line is skipped and
 *     counted, never throws (a partially-written file must not crash boot).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { dirname } from "node:path";
import { cfgInt } from "../../config.ts";

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
  /** Lines appended since the last full rewrite. Drives compaction. */
  #appends = 0;
  /** Full rewrites actually performed — see `rewriteCount`. */
  #rewrites = 0;

  /**
   * The live-set ceiling, resolved ONCE.
   *
   * `cfgInt` walks the config schema and reads the environment, which is
   * nothing next to a disk write but everything next to a Map insert: reading
   * it per upsert took the 100k-leaf bench from 0.02 ms to 0.15 ms per record,
   * a 7x regression on the hot path, to answer a question whose answer cannot
   * change inside a process.
   */
  readonly #cap: number;

  constructor(path: string) {
    this.#path = path;
    this.#inMemory = path === ":memory:" || path === "";
    const cap = cfgInt("CINDERPAW_FMS_MAX_LEAVES");
    this.#cap = Number.isFinite(cap) && cap > 0 ? cap : 0;
  }

  /** Load records from disk into memory. Returns counts; corrupt lines are
   *  skipped, never fatal. A no-op for the in-memory store or a missing file. */
  load(): { loaded: number; skipped: number } {
    this.#records.clear();
    if (this.#inMemory || !existsSync(this.#path)) return { loaded: 0, skipped: 0 };
    let replayed = 0;
    let skipped = 0;
    const raw = readFileSync(this.#path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as LeafRecord & { deleted?: boolean };
        if (rec && typeof rec.id === "number" && rec.deleted === true) {
          // Tombstone: the id was removed after the record above it was
          // written. Replaying in order is what makes that correct.
          this.#records.delete(rec.id);
          replayed++;
        } else if (rec && typeof rec.id === "number" && rec.provenance) {
          this.#records.set(rec.id, rec);
          replayed++;
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
    }
    // `loaded` is the LIVE record count, not the line count: the file is a
    // log, so a leaf updated twice is one record over two lines, and a
    // removed one is no record at all. Reporting lines would tell a caller
    // the store holds more than it does.
    const loaded = this.#records.size;
    // A log read back with far more lines than live records is exactly the
    // state compaction exists for, and boot is the cheapest moment to pay it.
    this.#appends = replayed;
    if (this.#shouldCompact()) this.#persist();
    return { loaded, skipped };
  }

  /** Insert or replace a record by id, durably, in O(1). */
  upsert(rec: LeafRecord): void {
    this.#records.set(rec.id, rec);
    this.#appendLines(() => [JSON.stringify(rec)]);
  }

  /** Insert or replace many records with ONE append. */
  upsertAll(recs: LeafRecord[]): void {
    if (recs.length === 0) return;
    for (const rec of recs) this.#records.set(rec.id, rec);
    this.#appendLines(() => recs.map((r) => JSON.stringify(r)));
  }

  /** Drop the given ids. Appends one tombstone per removed id. */
  remove(ids: number[]): void {
    const gone: number[] = [];
    for (const id of ids) {
      if (this.#records.delete(id)) gone.push(id);
    }
    if (gone.length > 0) {
      this.#appendLines(() => gone.map((id) => JSON.stringify({ id, deleted: true })));
    }
  }

  /** Full rewrites performed. Diagnostics: it is what makes "one rewrite per
   *  fact" versus "one rewrite per few hundred" measurable rather than
   *  asserted. An append is not a rewrite and does not count here. */
  get rewriteCount(): number {
    return this.#rewrites;
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

  /**
   * Append one or more lines, then compact if the log has drifted too far
   * from the live set.
   *
   * Every mutation used to rewrite the WHOLE file, and the fact extractor
   * calls `upsertLeaf` five to ten times at the end of every turn. At ten
   * thousand leaves and ~3 KB of embedding per leaf that is ten full
   * serialisations of roughly 30 MB to store ten short sentences, and the
   * cost grows with everything the agent has ever remembered. A write path
   * whose cost scales with the size of memory is the one shape that
   * guarantees the system gets slower the more useful it becomes.
   *
   * Append is O(1) and just as durable: one `appendFileSync` per mutation,
   * no deferred window, nothing lost to a crash that the old path would have
   * kept. `load()` replays the log with later-wins semantics, which is why
   * this is a format change and not a contract change.
   */
  #appendLines(makeLines: () => string[]): void {
    // The cap is a property of the LIVE SET, so it applies to the in-memory
    // store too and is enforced before the early return below.
    const overflow = this.#enforceCap();
    // Serialise lazily, and only when there is a file to write to. Building
    // the JSON for a 384-float embedding on every upsert of a `":memory:"`
    // store is work with no reader, and it cost the 100k-leaf bench five
    // times its per-record budget to produce output that was dropped.
    if (this.#inMemory) return;
    const lines = makeLines();
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      appendFileSync(this.#path, [...lines, ...overflow].join("\n") + "\n");
      this.#appends += lines.length + overflow.length;
      if (this.#shouldCompact()) this.#persist();
    } catch {
      // Best-effort persist: disk-full / permission errors must not crash the
      // turn. The in-memory map stays correct; the next mutation retries.
    }
  }

  /**
   * Enforce `CINDERPAW_FMS_MAX_LEAVES`, dropping the least-recently-seen rows.
   *
   * A backstop, deliberately separate from the eviction policy. That policy
   * answers "is this leaf stale" and can legitimately keep everything; this
   * answers "may the store be this large at all", which is the question a
   * person setting a cap is asking. Unset means no ceiling, which is the
   * behaviour every existing install already has.
   *
   * Returns the tombstone lines for whatever it dropped, so the caller folds
   * them into the same append rather than paying a second write.
   *
   * ponytail: least-recently-seen, not a full re-run of the eviction policy.
   * A ceiling that is only reached by an install already past its configured
   * size does not need to be clever about which row goes; it needs to be
   * predictable, and to actually happen.
   */
  #enforceCap(): string[] {
    const cap = this.#cap;
    if (cap <= 0 || this.#records.size <= cap) return [];
    const byAge = [...this.#records.values()].sort(
      (a, b) => a.provenance.last_seen_at - b.provenance.last_seen_at,
    );
    const dropCount = this.#records.size - cap;
    const tombstones: string[] = [];
    for (const rec of byAge.slice(0, dropCount)) {
      this.#records.delete(rec.id);
      tombstones.push(JSON.stringify({ id: rec.id, deleted: true }));
    }
    return tombstones;
  }

  /**
   * Compact when the log holds substantially more lines than live records.
   *
   * The floor matters as much as the ratio: without it a store of two leaves
   * would rewrite on almost every append, which is the behaviour this change
   * exists to remove. With it, a fresh profile appends freely and a large one
   * rewrites about once per doubling.
   */
  #shouldCompact(): boolean {
    return this.#appends > Math.max(256, this.#records.size);
  }

  /**
   * Atomic full rewrite.
   *
   * The temp file used to be a fixed `<path>.tmp`, shared by every writer and
   * left behind whenever the rename failed. `atomicWriteFileSync` gives each
   * write its own name, fsyncs before the rename, and cleans up after itself.
   */
  #persist(): void {
    if (this.#inMemory) return;
    this.#rewrites += 1;
    this.#appends = 0;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const body = this.all().map((r) => JSON.stringify(r)).join("\n");
      atomicWriteFileSync(this.#path, body.length ? body + "\n" : "");
    } catch {
      // Best-effort persist: disk-full / permission errors must not crash the turn.
      // The in-memory map stays correct; next boot will retry the write.
    }
  }
}
