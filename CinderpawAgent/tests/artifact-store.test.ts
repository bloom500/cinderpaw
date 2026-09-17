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

/**
 * A person's save lands in the same chain as the agent's edits, and never on
 * top of one they have not seen.
 *
 * The case this exists for: the person opens v2 and types for ten minutes;
 * meanwhile Cinderpaw, asked from Telegram, saves v3. A plain write would make
 * v4 out of the person's text and silently undo v3. The history would still
 * hold it, but nobody would know to look.
 */
describe("writeOnto", () => {
  test("a save on the current version is the next version, by the user", () => {
    const s = store();
    const a = make(s, "one");
    const res = s.writeOnto(a.id, "two", "user", 1);
    expect(res).toMatchObject({ ok: true });
    expect(s.get(a.id)?.version).toBe(2);
    expect(s.versions(a.id).find((v) => v.version === 2)?.author).toBe("user");
    expect(s.read(a.id)).toBe("two");
  });

  test("a save on a version the agent has since moved past is refused, and nothing is written", () => {
    const s = store();
    const a = make(s, "one");
    s.write(a.id, "agent edit", "telegram:7:7");
    const res = s.writeOnto(a.id, "person edit", "user", 1);
    expect(res).toEqual({ ok: false, current: 2 });
    expect(s.read(a.id)).toBe("agent edit");
    expect(s.get(a.id)?.version).toBe(2);
  });

  test("with no base version it writes regardless: the person chose to replace it", () => {
    const s = store();
    const a = make(s, "one");
    s.write(a.id, "agent edit", "telegram:7:7");
    expect(s.writeOnto(a.id, "person edit", "user")).toMatchObject({ ok: true });
    expect(s.read(a.id)).toBe("person edit");
    expect(s.readVersion(a.id, 2)).toBe("agent edit");
  });
});

describe("binary artifacts", () => {
  test("a PDF's bytes survive a write, a read and a rollback unchanged", () => {
    const s = store();
    const v1 = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xc3, 0x28]);
    const a = s.create({ kind: "pdf", title: "Signed", content: v1, workspaceId: "ws-1", sessionId: "user" });
    expect(a.bytes).toBe(8);
    s.write(a.id, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01]), "user");
    s.rollback(a.id, 1, "user");
    // 0xff and 0xc3 0x28 are invalid UTF-8: a text round trip would replace them.
    expect(Array.from(s.readBytes(a.id)!)).toEqual(Array.from(v1));
  });
});

/**
 * `null` from the wire means "no version", never "version null".
 *
 * The Rust host fills every optional field it did not get with JSON null. A
 * store that read null as a version to look up answered "has no version null"
 * to the first PDF anyone opened (17 Sep), and refused every "save mine as
 * newest" as stale, because null is not the current version.
 */
describe("a missing version arriving as null", () => {
  test("reads the current bytes", () => {
    const s = store();
    const a = make(s, "one");
    expect(new TextDecoder().decode(s.readBytes(a.id, null)!)).toBe("one");
  });

  test("saves without the stale check", () => {
    const s = store();
    const a = make(s, "one");
    s.write(a.id, "agent", "telegram:1:1");
    expect(s.writeOnto(a.id, "mine", "user", null)).toMatchObject({ ok: true });
    expect(s.read(a.id)).toBe("mine");
  });
});
