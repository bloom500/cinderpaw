/**
 * Astra, 20 Sep 2026, two reproduced defects:
 *  D1: artifact_export wrote the source bytes under a .xlsx / .pptx name and
 *      reported success. (.docx and .xlsx are real conversions now, see
 *      artifact-office.test.ts; .pptx still is not.)
 *  D2: the by-id tools looked an artifact up globally, so a workspace could
 *      read another workspace's artifact by id while artifact_list hid it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { ensureWorkspace, setActiveWorkspace } from "../src/memory/workspaces.ts";
import {
  activeWorkspaceId,
  createArtifactCreateTool,
  createArtifactExportTool,
  createArtifactListTool,
  createArtifactReadTool,
} from "../src/tools/builtin/artifact.ts";

function setup() {
  const db = openDatabase(":memory:");
  const out = mkdtempSync(join(tmpdir(), "cinderpaw-scope-out-"));
  const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-scope-")));
  const deps = { db: db.raw, store, workspaceRoots: [out] };
  const ctx = { sessionId: "d0b56fa7-6de5-4076-81a5-ef5625b81ac8" } as never;
  return { db, out, deps, ctx };
}

describe("artifact_export refuses formats it cannot write (D1)", () => {
  test("pptx and an unknown format are refused, nothing is written, pdf and the native format still work", async () => {
    const { out, deps, ctx } = setup();
    const create = createArtifactCreateTool(deps);
    const exp = createArtifactExportTool(deps);
    const made = await create.execute({ kind: "markdown", title: "Audit", content: "# Audit\n\nfine" }, ctx);
    const id = (made.data as { id: string }).id;

    for (const ext of ["pptx", "odt"]) {
      const r = await exp.execute({ id, dest: join(out, `wrong.${ext}`) }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("unsupported_format");
      expect(r.content).toContain(`.${ext}`);
      expect(existsSync(join(out, `wrong.${ext}`))).toBe(false);
    }
    expect((await exp.execute({ id, format: "key3" }, ctx)).error).toBe("unsupported_format");
    expect((await exp.execute({ id, dest: join(out, "right.md") }, ctx)).ok).toBe(true);
    expect((await exp.execute({ id, dest: join(out, "right.pdf") }, ctx)).ok).toBe(true);
  });
});

describe("artifacts stay inside their workspace (D2)", () => {
  test("an id from workspace A is not found from workspace B", async () => {
    const { db, deps, ctx } = setup();
    const create = createArtifactCreateTool(deps);
    const read = createArtifactReadTool(deps);
    const list = createArtifactListTool(deps);

    const a = activeWorkspaceId(db.raw);
    const made = await create.execute({ kind: "markdown", title: "Secret", content: "only A" }, ctx);
    const id = (made.data as { id: string }).id;
    expect((await read.execute({ id }, ctx)).ok).toBe(true);

    const b = ensureWorkspace(db.raw, "B").id;
    expect(b).not.toBe(a);
    setActiveWorkspace(db.raw, b);
    expect((await list.execute({}, ctx)).content).not.toContain("Secret");
    const fromB = await read.execute({ id }, ctx);
    expect(fromB.ok).toBe(false);
    expect(fromB.error).toBe("not_found");

    setActiveWorkspace(db.raw, a);
    expect((await read.execute({ id }, ctx)).ok).toBe(true);
  });
});
