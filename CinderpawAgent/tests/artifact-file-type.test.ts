/**
 * 6 Oct: asked for a CSV for a job-application video, the person got
 * job-application-workflow-test.csv.bin, four takes in a row. A 'file' artifact
 * always left with .bin whatever its title said, and artifact_export refused
 * "leads.csv" because the kind's own extension was .bin.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { artifactFile } from "../src/artifacts/export.ts";
import { createArtifactCreateTool, createArtifactExportTool } from "../src/tools/builtin/artifact.ts";

const CSV = 'company,city\nAcme Roofing,"Didsbury, Manchester"\n';

function setup() {
  const db = openDatabase(":memory:");
  const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-ftype-a-")));
  const out = mkdtempSync(join(tmpdir(), "cinderpaw-ftype-o-"));
  const deps = { db: db.raw, store, workspaceRoots: [out] };
  return { store, out, create: createArtifactCreateTool(deps), exporter: createArtifactExportTool(deps) };
}
const ctx = { sessionId: "d0b56fa7-6de5-4076-81a5-ef5625b81ac8" } as never;
const mk = (store: ArtifactStore, kind: "file" | "code" | "markdown", title: string) =>
  store.create({ kind, title, content: CSV, workspaceId: "w", sessionId: "s" });

describe("a file leaves with the type in its title", () => {
  test("a CSV titled leads.csv downloads as leads.csv, not leads.csv.bin", async () => {
    const { store } = setup();
    expect((await artifactFile(store, mk(store, "file", "leads.csv"))).name).toBe("leads.csv");
  });

  test("a script kept as code keeps its .py", async () => {
    const { store } = setup();
    expect((await artifactFile(store, mk(store, "code", "scrape.py"))).name).toBe("scrape.py");
  });

  test("a title that already ends in the kind's extension is not given it twice", async () => {
    const { store } = setup();
    expect((await artifactFile(store, mk(store, "markdown", "notes.md"))).name).toBe("notes.md");
  });

  test("a version number is not a file type", () => {
    expect(ArtifactStore.extensionOf({ kind: "code", title: "Release 1.2" })).toBe(".txt");
  });

  test("the agent's own export of leads.csv is written, byte for byte, not refused", async () => {
    const { out, create, exporter } = setup();
    const made = await create.execute({ kind: "file", title: "leads.csv", content: CSV }, ctx);
    const r = await exporter.execute({ id: (made.data as { id: string }).id, dest: "leads.csv" }, ctx);
    expect(r).toMatchObject({ ok: true });
    expect(readFileSync(join(out, "leads.csv"), "utf8")).toBe(CSV);
  });

  test("a file with no type in its title is refused with what to do", async () => {
    const { create } = setup();
    const r = await create.execute({ kind: "file", title: "Leads", content: CSV }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("leads.csv");
  });
});
