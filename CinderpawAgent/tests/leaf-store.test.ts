/**
 * LeafStore — Pathway 4 PR-C Task C.0.
 *
 * A durable, provenance-bearing store for reactively-captured fact leaves,
 * persisted to `<dataDir>/fractal-leaves.jsonl`. Closes step-2's "reactive
 * leaves in-memory only" gap: `upsertLeaf` writes through to this store so
 * leaves survive restart and carry the `last_seen_at` / `hit_count`
 * provenance that eviction (C.1/C.2) and cross-session dedup (C.3) read.
 *
 * What this suite guards:
 *   1. upsert + all round-trips a record.
 *   2. upsert with an existing id replaces in place (no duplicate).
 *   3. remove drops the given ids and persists.
 *   4. load tolerates a corrupt line (skips it, keeps valid records).
 *   5. atomic write (tmp + rename) — no `.tmp` left behind.
 *   6. restart round-trip — a fresh LeafStore over the same path sees prior records.
 *   7. `:memory:` path does no disk I/O.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeafStore, type LeafRecord } from "../src/memory/fractal/leaf-store.ts";

function rec(id: number, over: Partial<LeafRecord> = {}): LeafRecord {
  return {
    id,
    text: `fact ${id}`,
    vec: [1, 0, 0],
    ts: 1_000_000 + id,
    sessionId: "s1",
    provenance: {
      source: "reactive-engine",
      first_seen_at: 1_000_000 + id,
      last_seen_at: 1_000_000 + id,
      hit_count: 1,
    },
    ...over,
  };
}

describe("LeafStore", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cinderpaw-leafstore-")); });
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  const path = () => join(dir, "fractal-leaves.jsonl");

  test("upsert + all round-trips a record", () => {
    const store = new LeafStore(path());
    store.upsert(rec(1, { text: "language: ro" }));
    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(1);
    expect(all[0]?.text).toBe("language: ro");
    expect(all[0]?.provenance.hit_count).toBe(1);
  });

  test("upsert with an existing id replaces in place (no duplicate)", () => {
    const store = new LeafStore(path());
    store.upsert(rec(1, { provenance: { source: "x", first_seen_at: 1, last_seen_at: 1, hit_count: 1 } }));
    store.upsert(rec(1, { provenance: { source: "x", first_seen_at: 1, last_seen_at: 9, hit_count: 2 } }));
    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.provenance.hit_count).toBe(2);
    expect(all[0]?.provenance.last_seen_at).toBe(9);
  });

  test("remove drops the given ids and persists", () => {
    const store = new LeafStore(path());
    store.upsert(rec(1));
    store.upsert(rec(2));
    store.upsert(rec(3));
    store.remove([1, 3]);
    expect(store.all().map((r) => r.id)).toEqual([2]);
    // persisted: a fresh store over the same path agrees
    const reloaded = new LeafStore(path());
    reloaded.load();
    expect(reloaded.all().map((r) => r.id)).toEqual([2]);
  });

  test("load tolerates a corrupt line (skips it, keeps valid records)", () => {
    // one valid JSON record line + one garbage line
    writeFileSync(path(), JSON.stringify(rec(1)) + "\n" + "{not json]\n", "utf8");
    const store = new LeafStore(path());
    const res = store.load();
    expect(res.loaded).toBe(1);
    expect(res.skipped).toBe(1);
    expect(store.all().map((r) => r.id)).toEqual([1]);
  });

  test("uses an atomic write (tmp + rename) — no .tmp left behind", () => {
    const store = new LeafStore(path());
    store.upsert(rec(1));
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(existsSync(path())).toBe(true);
  });

  test("restart round-trip — a fresh LeafStore over the same path sees prior records", () => {
    const a = new LeafStore(path());
    a.upsert(rec(1, { text: "name: Alice" }));
    a.upsert(rec(2, { text: "language: ro" }));
    const b = new LeafStore(path());
    const res = b.load();
    expect(res.loaded).toBe(2);
    expect(b.all().map((r) => r.text).sort()).toEqual(["language: ro", "name: Alice"]);
  });

  test(":memory: path does no disk I/O", () => {
    const before = readdirSync(dir);
    const store = new LeafStore(":memory:");
    store.upsert(rec(1));
    store.upsert(rec(2));
    expect(store.all()).toHaveLength(2);
    // no file created anywhere in the temp dir
    expect(readdirSync(dir)).toEqual(before);
  });

  test("summaries() exposes provenance fields for eviction/dedup", () => {
    const store = new LeafStore(":memory:");
    store.upsert(rec(1, { text: "k: v", provenance: { source: "r", first_seen_at: 100, last_seen_at: 200, hit_count: 3 } }));
    const sums = store.summaries();
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({ id: 1, text: "k: v", first_seen_at: 100, last_seen_at: 200, hit_count: 3 });
  });
});
