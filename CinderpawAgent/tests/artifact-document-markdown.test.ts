/**
 * 30 Sep: asked for three campfire recipes, the agent wrote Markdown into a
 * 'document' (an HTML kind). The panel framed it as a web page, so the whole
 * report showed as one run-on line with its #, | and ** in plain sight, and a
 * PDF or Word export ran it through the HTML converter. Models write Markdown;
 * a document that arrives as Markdown is stored as Markdown.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore, looksLikeHtml } from "../src/artifacts/store.ts";
import { artifactFile } from "../src/artifacts/export.ts";
import { docxText } from "../src/artifacts/docx.ts";
import { createArtifactCreateTool } from "../src/tools/builtin/artifact.ts";

const MD = "# Trei rețete\n\n| Criteriu | Chili |\n|---|---|\n| Timp | 1 h 50 |\n\n**Verdict:** chili-ul.";

function setup() {
  const db = openDatabase(":memory:");
  const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-docmd-a-")));
  return { store, create: createArtifactCreateTool({ db: db.raw, store, workspaceRoots: [] }) };
}
const ctx = { sessionId: "d0b56fa7-6de5-4076-81a5-ef5625b81ac8" } as never;

describe("a document written in Markdown", () => {
  test("is stored as markdown, so it renders with its headings and tables", async () => {
    const { create } = setup();
    const r = await create.execute({ kind: "document", title: "Rețete", content: MD }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { kind: string }).kind).toBe("markdown");
  });

  test("a document written in HTML stays a document", async () => {
    const { create } = setup();
    const r = await create.execute({ kind: "document", title: "Q3", content: "<h1>Q3</h1><p>Up.</p>" }, ctx);
    expect((r.data as { kind: string }).kind).toBe("document");
  });

  test("one already saved as a document still exports to Word as clean text", async () => {
    const { store } = setup();
    const a = store.create({ kind: "document", title: "Rețete", content: MD, workspaceId: "w", sessionId: "s" });
    const file = await artifactFile(store, a, "docx");
    const text = docxText(file.content as Uint8Array);
    expect(text).toContain("Trei rețete");
    expect(text).not.toContain("**");
    expect(text).not.toContain("# Trei");
  });

  test("looksLikeHtml tells the two apart", () => {
    expect(looksLikeHtml(MD)).toBe(false);
    expect(looksLikeHtml("<p>hi</p>")).toBe(true);
    expect(looksLikeHtml("text with a <br> in it")).toBe(false);
  });
});
