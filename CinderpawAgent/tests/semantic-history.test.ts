import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase, migrateForTests } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";

function mem() {
  const db = openDatabase(":memory:");
  return new SemanticMemory(db.raw, () => {});
}

describe("semantic history", () => {
  it("keeps the old value as a closed version when a fact changes", () => {
    const sem = mem();
    sem.upsert("editor", "vim", "", "preference");
    sem.upsert("editor", "helix", "", "preference");
    expect(sem.current().map((f) => f.value)).toEqual(["helix"]);
    expect(sem.current()[0]!.category).toBe("preference");
    const h = sem.history("editor");
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ value: "vim", category: "preference", supersededBy: h[1]!.id });
    expect(h[0]!.validTo).not.toBeNull();
    expect(h[1]).toMatchObject({ value: "helix", validTo: null, supersededBy: null });
  });

  it("does not open a new version when the same value is re-stated", () => {
    const sem = mem();
    sem.upsert("units", "metric");
    sem.upsert("units", "metric");
    expect(sem.history("units")).toHaveLength(1);
  });

  it("answers as-of and changed-since from the history", () => {
    const sem = mem();
    const t0 = Date.now();
    sem.upsert("editor", "vim", "", "preference", t0 + 10);
    sem.upsert("editor", "helix", "", "preference", t0 + 20);
    expect(sem.asOf(t0 + 15).find((f) => f.key === "editor")?.value).toBe("vim");
    expect(sem.asOf(t0 + 25).find((f) => f.key === "editor")?.value).toBe("helix");
    expect(sem.asOf(t0 + 5)).toEqual([]);
    expect(sem.changedSince(t0 + 15).map((f) => f.key)).toEqual(["editor"]);
    expect(sem.changedSince(t0 + 25)).toEqual([]);
  });

  it("stores an unknown category as fact", () => {
    const sem = mem();
    sem.upsert("k", "v", "", "banana" as never);
    expect(sem.current()[0]!.category).toBe("fact");
  });

  it("closes the open version when a fact is deleted", () => {
    const sem = mem();
    sem.upsert("k", "v");
    sem.delete("k");
    expect(sem.current()).toEqual([]);
    expect(sem.history("k")[0]!.validTo).not.toBeNull();
  });

  it("seeds one open version per pre-existing row on migration, once", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE semantic (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.exec("INSERT INTO semantic VALUES ('name', 'x', 1000)");
    migrateForTests(db);
    migrateForTests(db);
    const sem = new SemanticMemory(db, () => {});
    expect(sem.history("name")).toEqual([
      expect.objectContaining({ value: "x", category: "fact", validFrom: 1000, validTo: null }),
    ]);
  });
});

describe("SemanticMemory.closedAt — the label recall puts on a fact leaf", () => {
  it("the current value is not superseded, the replaced one is", () => {
    const sem = mem();
    sem.upsert("city", "Paris", "", "fact", 100);
    sem.upsert("city", "London", "", "fact", 200);
    // A leaf is written just after its value (extractor order: upsert, then hook).
    expect(sem.closedAt("city", 101)).toBe(200);
    expect(sem.closedAt("city", 201)).toBeNull();
  });

  it("three values: each leaf gets the close of its own version", () => {
    const sem = mem();
    sem.upsert("city", "Paris", "", "fact", 100);
    sem.upsert("city", "London", "", "fact", 200);
    sem.upsert("city", "Lisbon", "", "fact", 300);
    expect(sem.closedAt("city", 150)).toBe(200);
    expect(sem.closedAt("city", 250)).toBe(300);
    expect(sem.closedAt("city", 350)).toBeNull();
  });

  it("a forgotten fact is closed at the forgetting; an unknown key is null", () => {
    const sem = mem();
    sem.upsert("city", "Paris", "", "fact", 100);
    sem.delete("city");
    expect(sem.closedAt("city", 101)).not.toBeNull();
    expect(sem.closedAt("nothing", 101)).toBeNull();
  });
});
