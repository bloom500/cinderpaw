/**
 * Designs and animations are `app` artifacts. What makes them work for a
 * stranger is that the agent can FIND the tool when asked for one: artifact_create
 * sits in the drawer, and list_tools filters on name + description. A search for
 * "animation" that matched nothing ended in "I can't make videos" (17 Oct).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { createArtifactCreateTool } from "../src/tools/builtin/artifact.ts";

function setup() {
  const db = openDatabase(":memory:");
  const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-motion-")));
  return { store, create: createArtifactCreateTool({ db: db.raw, store, workspaceRoots: [] }) };
}
const ctx = { sessionId: "d0b56fa7-6de5-4076-81a5-ef5625b81ac8" } as never;

describe("designs and animations", () => {
  test("a drawer search for them finds artifact_create", () => {
    const { create } = setup();
    // The same match list_tools does (tool-drawer.ts): lower-cased substring.
    const text = `${create.manifest.name} ${create.manifest.description}`.toLowerCase();
    for (const q of ["design", "animation", "poster", "board"]) expect(text).toContain(q);
    // The first sentence is what the drawer index shows; both words must be in it.
    const first = create.manifest.description.split(". ")[0]!.toLowerCase();
    expect(first).toContain("design");
    expect(first).toContain("animation");
  });

  test("an animation is stored as an app", async () => {
    const { create, store } = setup();
    const html = "<!doctype html><style>@keyframes s{to{transform:rotate(1turn)}}div{animation:s 2s linear infinite}</style><div>Hi</div>";
    const r = await create.execute({ kind: "app", title: "Spinning hello", content: html }, ctx);
    expect(r.ok).toBe(true);
    const id = (r.data as { id: string }).id;
    expect(store.read(id)).toContain("@keyframes");
  });
});
