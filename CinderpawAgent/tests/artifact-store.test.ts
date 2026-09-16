/**
 * The artifact store's contract, pinned.
 *
 * Four of these guard a promise the rest of the system will make on top of this
 * one: that an artifact can be edited by id without losing what it said before,
 * that an undo is itself recorded, that nothing the agent made disappears
 * silently, and that a title can never become a path.
 *
 * The last one is not hypothetical. Titles come from a model, which takes them
 * from users, on 21 chat platforms. "Q3: revenue vs plan" is an illegal
 * filename on Windows, and "../../etc/passwd" is a title someone will
 * eventually send on purpose.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore, type ArtifactChangeEvent } from "../src/artifacts/store.ts";
import { safeFileName } from "../src/tools/builtin/artifact.ts";

function store(events?: ArtifactChangeEvent[]) {
  const db = openDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "cinderpaw-artifacts-"));
  return new ArtifactStore(db.raw, root, {
    onChange: events ? (e) => events.push(e) : undefined,
  });
}

function make(s: ArtifactStore, content = "hello") {
  return s.create({
    kind: "markdown",
    title: "Notes",
    content,
    workspaceId: "ws-1",
    sessionId: "discord:1:2",
  });
}

describe("ArtifactStore", () => {
  test("a created artifact is readable back, by id", () => {
    const s = store();
    const a = make(s, "# Report\n\nbody");
    expect(a.version).toBe(1);
    expect(s.read(a.id)).toBe("# Report\n\nbody");
    expect(s.get(a.id)?.title).toBe("Notes");
  });

  test("an edit makes a new version and leaves the old content readable", () => {
    const s = store();
    const a = make(s, "first");
    const updated = s.write(a.id, "second", "user", "manual edit");

    expect(updated?.version).toBe(2);
    expect(s.read(a.id)).toBe("second");
    // The whole point of keeping whole files: v1 is still there, byte for byte.
    expect(s.readVersion(a.id, 1)).toBe("first");
    expect(s.versions(a.id).map((v) => v.version)).toEqual([2, 1]);
    // Who edited it is what lets manual and agent edits share one document.
    expect(s.versions(a.id)[0]?.author).toBe("user");
  });

  test("rollback writes the old content FORWARD, so the undo is itself history", () => {
    const s = store();
    const a = make(s, "v1 text");
    s.write(a.id, "v2 text", "agent");
    const rolled = s.rollback(a.id, 1, "agent");

    expect(rolled?.version).toBe(3);
    expect(s.read(a.id)).toBe("v1 text");
    // Nothing was rewound: v2 is still readable, so an undo of the undo works.
    expect(s.readVersion(a.id, 2)).toBe("v2 text");
  });

  test("a removed artifact leaves the list but keeps its bytes", () => {
    const s = store();
    const a = make(s, "keep me");
    expect(s.remove(a.id, "user")).toBe(true);

    expect(s.get(a.id)).toBeNull();
    expect(s.list()).toHaveLength(0);
    // Soft delete: the file is still on disk, so the user can be given it back.
    expect(existsSync(a.path)).toBe(true);
    expect(readFileSync(a.path, "utf8")).toBe("keep me");
  });

  test("purge is the one that really deletes", () => {
    const s = store();
    const a = make(s);
    s.purge(a.id);
    expect(existsSync(a.path)).toBe(false);
    expect(s.versions(a.id)).toHaveLength(0);
  });

  test("every change is announced once, with what changed", () => {
    const events: ArtifactChangeEvent[] = [];
    const s = store(events);
    const a = make(s);
    s.write(a.id, "x", "user");
    s.remove(a.id, "user");

    expect(events.map((e) => e.action)).toEqual(["created", "updated", "deleted"]);
    expect(events[1]?.version).toBe(2);
    expect(events[0]?.sessionId).toBe("discord:1:2");
  });

  test("a listener that throws cannot undo a write that succeeded", () => {
    const db = openDatabase(":memory:");
    const root = mkdtempSync(join(tmpdir(), "cinderpaw-artifacts-"));
    const s = new ArtifactStore(db.raw, root, {
      onChange: () => {
        throw new Error("the UI is gone");
      },
    });
    const a = make(s);
    expect(s.read(a.id)).toBe("hello");
  });

  test("list is newest first and hides deleted rows", () => {
    const s = store();
    const first = make(s);
    const second = s.create({
      kind: "document", title: "Second", content: "<p>b</p>",
      workspaceId: "ws-1", sessionId: "s",
    });
    s.write(first.id, "touched", "user");

    expect(s.list().map((a) => a.id)).toEqual([first.id, second.id]);
    expect(s.list({ kind: "document" }).map((a) => a.id)).toEqual([second.id]);
    s.remove(first.id, "user");
    expect(s.list().map((a) => a.id)).toEqual([second.id]);
  });

  test("an unknown kind on disk degrades to `file` instead of throwing", () => {
    const db = openDatabase(":memory:");
    const root = mkdtempSync(join(tmpdir(), "cinderpaw-artifacts-"));
    const s = new ArtifactStore(db.raw, root);
    const a = make(s);
    // Simulates a row written by a newer build, or edited by hand. One bad row
    // must not make the whole list unopenable.
    db.raw.prepare("UPDATE artifact SET kind = 'hologram' WHERE id = ?").run(a.id);

    expect(s.get(a.id)?.kind).toBe("file");
    expect(s.list()).toHaveLength(1);
  });
});

describe("safeFileName", () => {
  test("a title can never become a path", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a/b\\c")).not.toContain("/");
    expect(safeFileName("a/b\\c")).not.toContain("\\");
  });

  test("characters Windows refuses in a filename are replaced, not kept", () => {
    const name = safeFileName('Q3: revenue vs plan? <draft>');
    for (const bad of [":", "?", "<", ">", '"', "|", "*"]) {
      expect(name).not.toContain(bad);
    }
    expect(name.length).toBeGreaterThan(0);
  });

  test("a title with nothing usable in it still produces a filename", () => {
    expect(safeFileName("///")).toBe("artifact");
    expect(safeFileName("   ")).toBe("artifact");
    expect(safeFileName("...")).toBe("artifact");
  });
});
