/**
 * LeafStore write path — the cost of remembering one fact.
 *
 * Every mutation used to rewrite the whole file. The fact extractor calls
 * `upsertLeaf` five to ten times at the end of a turn, so storing ten short
 * sentences re-serialised every embedding the agent had ever kept: at ten
 * thousand leaves and ~3 KB each, roughly 300 MB of writes for ten sentences.
 * The cost scaled with the size of memory, which is the one shape that makes a
 * system get slower the more useful it becomes.
 *
 * These tests hold the new contract: appends are O(1), the log still reads
 * back exactly, and compaction is rare rather than constant.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LeafStore, type LeafRecord } from "../src/memory/fractal/leaf-store.ts";

const dirs: string[] = [];
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "leafstore-"));
  dirs.push(dir);
  return join(dir, "fractal-leaves.jsonl");
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* windows handle */ }
  }
});

let envRestore: (() => void) | null = null;
afterEach(() => {
  envRestore?.();
  envRestore = null;
});

function withEnv(name: string, value: string | undefined): void {
  const prev = process.env[name];
  envRestore = () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function rec(id: number, over: Partial<LeafRecord> = {}): LeafRecord {
  return {
    id,
    text: `fact ${id}`,
    vec: [0.1, 0.2, 0.3],
    ts: 1000 + id,
    sessionId: "s1",
    provenance: {
      source: "test",
      first_seen_at: 1000 + id,
      last_seen_at: 1000 + id,
      hit_count: 1,
      ...(over.provenance ?? {}),
    },
    ...over,
  };
}

describe("LeafStore — append instead of rewrite", () => {
  test("a turn's worth of facts costs zero full rewrites", async () => {
    const store = new LeafStore(storePath());
    for (let i = 1; i <= 10; i++) store.upsert(rec(i));

    // Ten facts used to mean ten rewrites of the entire store.
    expect(store.rewriteCount).toBe(0);
    expect(store.all()).toHaveLength(10);
  });

  test("the log reads back exactly, with later writes winning", async () => {
    const path = storePath();
    const a = new LeafStore(path);
    a.upsert(rec(1, { text: "first" }));
    a.upsert(rec(2, { text: "other" }));
    a.upsert(rec(1, { text: "corrected" })); // same id, written again

    const b = new LeafStore(path);
    const res = b.load();

    expect(res.loaded).toBe(2); // live records, not lines
    expect(b.all().find((r) => r.id === 1)?.text).toBe("corrected");
  });

  test("a removal survives restart as a tombstone", async () => {
    const path = storePath();
    const a = new LeafStore(path);
    a.upsert(rec(1));
    a.upsert(rec(2));
    a.remove([1]);

    const b = new LeafStore(path);
    expect(b.load().loaded).toBe(1);
    expect(b.all().map((r) => r.id)).toEqual([2]);
  });

  test("the log is compacted once it outgrows the live set", async () => {
    const path = storePath();
    const store = new LeafStore(path);
    // One id rewritten many times: the live set stays at 1 while the log grows,
    // which is exactly the case an append-only file has to bound.
    for (let i = 0; i < 300; i++) store.upsert(rec(1, { text: `v${i}` }));

    expect(store.rewriteCount).toBeGreaterThan(0);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(300);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.text).toBe("v299");
  });
});

describe("LeafStore — CINDERPAW_FMS_MAX_LEAVES", () => {
  test("unset means no ceiling, which is what every install has today", async () => {
    withEnv("CINDERPAW_FMS_MAX_LEAVES", undefined);
    const store = new LeafStore(storePath());
    for (let i = 1; i <= 50; i++) store.upsert(rec(i));
    expect(store.all()).toHaveLength(50);
  });

  test("the cap is enforced, dropping the least recently seen", async () => {
    // It was registered in config and documented as "Cap on the FMS leaf store
    // size" while nothing in the codebase read it.
    withEnv("CINDERPAW_FMS_MAX_LEAVES", "5");
    const path = storePath();
    const store = new LeafStore(path);
    for (let i = 1; i <= 20; i++) store.upsert(rec(i)); // last_seen_at grows with i

    expect(store.all()).toHaveLength(5);
    expect(store.all().map((r) => r.id).sort((x, y) => x - y)).toEqual([16, 17, 18, 19, 20]);

    // And the drop is durable, not just in memory.
    const reloaded = new LeafStore(path);
    expect(reloaded.load().loaded).toBe(5);
  });
});
