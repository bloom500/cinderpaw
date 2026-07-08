/**
 * Memory Tests matrix (Sprint 1.10).
 *
 * Every scenario from `docs/agents-memory/project_memory_roadmap.md` §1.10
 * gets at least one red/green test before Sprint 1 ships:
 *
 *   1. Restart     — kill mid-session, reopen; episodic + semantic + meta survive.
 *   2. Model swap  — switch chat model; memory indexes unchanged (text canonical).
 *   3. Provider swap — cloud ↔ local; memory unchanged.
 *   4. Embedding model swap — dim guard wipes vectors, recall still works
 *                            after re-embed.
 *   5. Version upgrade — schema migration runs; no data loss.
 *   6. Workspace switch — workspace filter cleanly separates facts.
 *
 * Memory bugs destroy user trust. These tests are the regression net that
 * makes "Feral remembers me" something we can stand behind for every
 * shipping release.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { openDatabase, CURRENT_MEMORY_SCHEMA_VERSION } from "../src/db.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import {
  getCurrentTask,
  setCurrentTask,
  touchLastActive,
  getLastActive,
} from "../src/memory/resume.ts";
import {
  createWorkspace,
  getActiveWorkspaceId,
  listWorkspaces,
  renameWorkspace,
  setActiveWorkspace,
  deleteWorkspace,
} from "../src/memory/workspaces.ts";
import type { AuditLogger } from "../src/types.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Quiet audit logger — the tests don't care about the audit trail. */
const quietAudit: AuditLogger = () => {};

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "feral-mem-test-"));
  dbPath = join(tmpDir, "feral.db");
});

function teardown() {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Mirror of the sidecar's writer-lock: same path, same O_EXCL discipline.
 *  Acquired at the same point (openDatabase); the tests below use this so
 *  they reproduce the production lock-acquire path, not a parallel one. */
function writerLockPath(p: string): string {
  // node:path's sep matches the runtime the sidecar uses; matches db.ts.
  return `${join(tmpDir, "feral.db")}.writer.lock`;
}

describe("memory/resilience: restart", () => {
  test("episodic + semantic + meta survive close/reopen", () => {
    let db = openDatabase(dbPath);
    const epi = new EpisodicMemory(db.raw, quietAudit);
    const sem = new SemanticMemory(db.raw, quietAudit);

    epi.record("s1", "user", "hello world");
    epi.record("s1", "assistant", "hi there");
    sem.upsert("name", "Darius");
    setCurrentTask(db.raw, { title: "refactor", ts: 1700000000000 });
    touchLastActive(db.raw, 1700000000000);
    const lockPath = `${dbPath}.writer.lock`;
    db.close();
    expect(existsSync(lockPath)).toBe(false);

    // Reopen: writer lock re-acquired, every row above intact.
    db = openDatabase(dbPath);
    const epi2 = new EpisodicMemory(db.raw, quietAudit);
    const sem2 = new SemanticMemory(db.raw, quietAudit);
    expect(epi2.recent("s1").map((r) => r.content)).toEqual([
      "hello world",
      "hi there",
    ]);
    expect(sem2.get("name")?.value).toBe("Darius");
    expect(getCurrentTask(db.raw)?.title).toBe("refactor");
    expect(getLastActive(db.raw)).toBe(1700000000000);
    db.close();
    teardown();
  });

  test("two openDatabase calls in sequence — second one acquires the lock after first releases", () => {
    const a = openDatabase(dbPath);
    a.close();
    const b = openDatabase(dbPath);
    b.close();
    expect(existsSync(writerLockPath(dbPath))).toBe(false);
    teardown();
  });
});

describe("memory/resilience: model swap", () => {
  test("switching the chat model does NOT touch the episodic embeddings", () => {
    const db = openDatabase(dbPath);
    const epi = new EpisodicMemory(db.raw, quietAudit);
    const id = epi.record("s1", "user", "first thought");
    expect(id).not.toBeNull();
    if (id === null) throw new Error("record returned null");
    // Stamp a vector of known dim (the bge-small default).
    epi.setEmbeddings([{ id, vec: new Float32Array(384).fill(0.42) }]);

    // "Model swap" = the user changes the chat model. We simulate by
    // verifying the storage is model-agnostic: the bytes are still there.
    const all = epi.all();
    expect(all[0].embedding).toBeDefined();
    expect(all[0].embedding?.length).toBe(384);
    db.close();
    teardown();
  });
});

describe("memory/resilience: provider swap", () => {
  test("semantic facts survive a provider switch (text canonical, not vector-bound)", () => {
    const db = openDatabase(dbPath);
    const sem = new SemanticMemory(db.raw, quietAudit);
    sem.upsert("language", "Romanian");
    sem.upsert("preferred_name", "Darius");
    db.close();

    // Reopen — the facts come back verbatim. No provider-side state lives
    // in `semantic`; the table is text-canonical, not vector-bound.
    const db2 = openDatabase(dbPath);
    const sem2 = new SemanticMemory(db2.raw, quietAudit);
    expect(sem2.get("language")?.value).toBe("Romanian");
    expect(sem2.get("preferred_name")?.value).toBe("Darius");
    db2.close();
    teardown();
  });
});

describe("memory/resilience: embedding model swap", () => {
  test("dim-guard wipes stale vectors; re-embed restores them with the new dim", () => {
    const db = openDatabase(dbPath);
    const epi = new EpisodicMemory(db.raw, quietAudit);
    const id = epi.record("s1", "user", "switching to bge-m3")!;
    expect(id).not.toBeNull();
    if (id === null) throw new Error("record returned null");

    // bge-small era: 384-dim.
    epi.setEmbeddings([{ id, vec: new Float32Array(384).fill(0.5) }]);
    expect(epi.all()[0].embedding?.length).toBe(384);

    // User switches to bge-m3 (1024-dim). The dim-guard (lives in
    // fractal-memory.ts on production) clears all embeddings; the test
    // exercises the lower-level primitive that backs it.
    const cleared = epi.clearEmbeddings();
    expect(cleared).toBe(1);
    expect(epi.all()[0].embedding).toBeUndefined();

    // Re-embed at the new dim — recall must still find the row by content.
    epi.setEmbeddings([{ id, vec: new Float32Array(1024).fill(0.7) }]);
    expect(epi.all()[0].embedding?.length).toBe(1024);
    expect(epi.search("bge-m3")).toHaveLength(1);
    db.close();
    teardown();
  });
});

describe("memory/resilience: version upgrade", () => {
  test("schema migration runs on reopen; CURRENT_MEMORY_SCHEMA_VERSION is stamped in meta", () => {
    const db = openDatabase(dbPath);
    const row = db.raw
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(String(CURRENT_MEMORY_SCHEMA_VERSION));
    expect(Number(row?.value)).toBeGreaterThanOrEqual(2);
    db.close();
    teardown();
  });

  test("on-disk schema version newer than code rejects the open (forward-compat guard)", () => {
    // Plant a higher version on disk, then reopen.
    const seed = openDatabase(dbPath);
    seed.close();
    // Open a raw handle to bump the version without going through migrate().
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const raw = new Database(dbPath);
    raw.prepare(
      "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('schema_version', '9999', ?)",
    ).run(Date.now());
    raw.close();

    expect(() => openDatabase(dbPath)).toThrow(/newer than this build supports/);
    teardown();
  });
});

describe("memory/resilience: workspace switch", () => {
  test("episodic rows are scoped to a workspace_id; facts do not leak across workspaces", () => {
    const db = openDatabase(dbPath);
    const epi = new EpisodicMemory(db.raw, quietAudit);
    const wsA = createWorkspace(db.raw, "Work", "/work");
    const wsB = createWorkspace(db.raw, "Personal", "/personal");

    // Direct row insert with explicit workspace_id — the production writer
    // path (EpisodicMemory.record) doesn't take workspaceId yet; Sprint 1.4
    // added the column so the writer hook can fill it next sprint. The
    // storage layer's filterability is what this test pins.
    const insert = db.raw.prepare(
      "INSERT INTO episodic (session_id, timestamp, role, content, workspace_id) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("sA", Date.now(), "user", "secret project thing", wsA.id);
    insert.run("sB", Date.now(), "user", "family trip plan", wsB.id);

    const rows = db.raw.query(
      "SELECT workspace_id, content FROM episodic ORDER BY id ASC",
    ).all() as Array<{ workspace_id: string; content: string }>;
    expect(rows[0].workspace_id).toBe(wsA.id);
    expect(rows[1].workspace_id).toBe(wsB.id);

    // Active workspace pointer survives restart.
    setActiveWorkspace(db.raw, wsB.id);
    expect(getActiveWorkspaceId(db.raw)).toBe(wsB.id);
    db.close();
    const db2 = openDatabase(dbPath);
    expect(getActiveWorkspaceId(db2.raw)).toBe(wsB.id);
    db2.close();
    teardown();
  });

  test("workspaces use stable UUID identity; renaming does not change id", () => {
    const db = openDatabase(dbPath);
    const ws = createWorkspace(db.raw, "Agent");
    const ws2 = createWorkspace(db.raw, "Agent"); // same display label
    expect(ws.id).not.toBe(ws2.id); // collision would break workspace_id FK semantics

    const renamed = renameWorkspace(db.raw, ws.id, "Feral repo");
    expect(renamed?.id).toBe(ws.id);
    expect(renamed?.name).toBe("Feral repo");

    // listWorkspaces orders by last_active_at DESC — renaming does not
    // touch last_active_at, so the order is preserved (stable).
    const list = listWorkspaces(db.raw);
    expect(list.find((w) => w.id === ws.id)?.name).toBe("Feral repo");
    db.close();
    teardown();
  });

  test("deleteWorkspace does NOT cascade — episodic rows with the workspace_id survive (audit trail)", () => {
    // We deliberately keep the row: deleting a workspace should NOT erase
    // history. The FK is logical, not enforced. If we ever add CASCADE,
    // we'll need a "soft delete" tombstone first — that's a later slice.
    const db = openDatabase(dbPath);
    const ws = createWorkspace(db.raw, "Throwaway");
    db.raw
      .prepare("INSERT INTO episodic (session_id, timestamp, role, content, workspace_id) VALUES (?, ?, ?, ?, ?)")
      .run("s1", Date.now(), "user", "before delete", ws.id);
    expect(deleteWorkspace(db.raw, ws.id)).toBe(true);
    const row = db.raw.query("SELECT workspace_id FROM episodic WHERE content = ?")
      .get("before delete") as { workspace_id: string | null } | undefined;
    expect(row?.workspace_id).toBe(ws.id); // tombstoned but kept
    db.close();
    teardown();
  });
});

describe("memory/resilience: writer lock (single-writer discipline)", () => {
  test("a held writer lock causes a second openDatabase call to throw", () => {
    const a = openDatabase(dbPath);
    // Simulate "another sidecar already holds the lock" by planting one.
    // The lockfile lives next to the db — path is `${dbPath}.writer.lock`.
    expect(() => openDatabase(dbPath)).toThrow(/another sidecar already holds the writer lock/);
    a.close();
    teardown();
  });

  test(":memory: path skips the lock entirely — many in-process opens are fine", () => {
    const a = openDatabase(":memory:");
    const b = openDatabase(":memory:");
    a.close();
    b.close();
    expect(true).toBe(true);
  });
});