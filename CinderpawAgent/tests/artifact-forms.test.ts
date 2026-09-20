/**
 * The paperwork flow: download the real form, read it, fill it, leave the
 * signature to the person.
 *
 * Each step is checked on the file that comes out, read back by a parser: a
 * name "placed" on a line is only filled if extracting the page puts it on that
 * same line.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { pdfFields, pdfFromMarkdown, pdfLayout, pdfText } from "../src/artifacts/pdf.ts";
import { docxText } from "../src/artifacts/docx.ts";
import * as tools from "../src/tools/builtin/artifact.ts";
import type { CinderpawFetchResponse } from "../src/types.ts";

function setup(serve?: (url: string) => CinderpawFetchResponse) {
  const db = openDatabase(":memory:");
  const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-forms-")));
  const deps = { db: db.raw, store, workspaceRoots: [] };
  const ctx = {
    sessionId: "d0b56fa7-6de5-4076-81a5-ef5625b81ac8",
    fetch: async (url: string) => serve!(url),
  } as never;
  return {
    // The tools only see the active workspace now (Astra D2, 20 Sep), so a
    // test that seeds the store directly has to seed it there.
    store, ctx, ws: tools.activeWorkspaceId(db.raw),
    download: tools.createArtifactDownloadTool({ ...deps, allowedDomains: ["*"] }),
    read: tools.createArtifactReadTool(deps),
    edit: tools.createArtifactEditTool(deps),
  };
}

function response(bytes: Uint8Array, headers: Record<string, string> = {}, truncated = false): CinderpawFetchResponse {
  return {
    status: 200, ok: true, headers, truncated,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => ({}),
    bytes: async () => bytes,
  };
}

async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  doc.getForm().createTextField("nume").addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  return doc.save();
}

describe("artifact_download", () => {
  test("keeps a PDF byte for byte, named after the file", async () => {
    const pdf = await pdfFromMarkdown("# Cerere", "x");
    const t = setup(() => response(pdf, { "content-type": "application/pdf" }));
    const res = await t.download.execute({ url: "https://example.ro/formulare/Cerere%20REV%203.pdf" }, t.ctx);
    expect(res.ok).toBe(true);
    const id = (res.data as { id: string }).id;
    expect(t.store.get(id)).toMatchObject({ kind: "pdf", title: "Cerere REV 3" });
    expect(Array.from(t.store.readBytes(id)!)).toEqual(Array.from(pdf));
  });

  test("recognises a Word file by its bytes, and takes the name the server gives", async () => {
    const docx = zipSync({ "word/document.xml": strToU8("<w:document><w:body><w:p><w:r><w:t>Anexa</w:t></w:r></w:p></w:body></w:document>") });
    const t = setup(() => response(docx, { "content-disposition": 'attachment; filename="anexa_1.docx"' }));
    const res = await t.download.execute({ url: "https://example.ro/download?id=7" }, t.ctx);
    expect(t.store.get((res.data as { id: string }).id)).toMatchObject({ kind: "docx", title: "anexa_1" });
  });

  test("a web page is refused with what to do instead", async () => {
    const t = setup(() => response(strToU8("<html>forms here</html>"), { "content-type": "text/html" }));
    const res = await t.download.execute({ url: "https://example.ro/formulare" }, t.ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain("fetch_url");
  });

  test("a file cut off by the size limit is refused, never stored half", async () => {
    const t = setup(() => response(truncatedPdfStub(), {}, true));
    const res = await t.download.execute({ url: "https://example.ro/big.pdf" }, t.ctx);
    expect(res).toMatchObject({ ok: false, error: "too_large" });
  });
});

function truncatedPdfStub(): Uint8Array {
  return strToU8("%PDF-1.7 truncated");
}

describe("reading and filling a PDF form", () => {
  test("read lists the form's fields, and `fields` fills them", async () => {
    const t = setup();
    const a = t.store.create({ kind: "pdf", title: "F", content: await formPdf(), workspaceId: t.ws, sessionId: "s" });
    const read = await t.read.execute({ id: a.id }, t.ctx);
    expect(read.content).toContain("- nume (text)");
    const res = await t.edit.execute({ id: a.id, fields: { nume: "Darius Popescu" } }, t.ctx);
    expect(res.ok).toBe(true);
    expect(await pdfFields(t.store.readBytes(a.id)!)).toEqual([{ name: "nume", type: "text", value: "Darius Popescu" }]);
  });

  test("a flat form: layout finds the blank, and text placed there lands on that line", async () => {
    const t = setup();
    const pdf = await pdfFromMarkdown("# Cerere\n\nNume și prenume: ....................\n\nData: ..........", "C");
    const a = t.store.create({ kind: "pdf", title: "C", content: pdf, workspaceId: t.ws, sessionId: "s" });

    const read = await t.read.execute({ id: a.id, layout: true }, t.ctx);
    const line = read.content.split("\n").find((l) => l.startsWith("p") && l.includes("Nume și prenume"))!;
    const [, page, y, , x1] = /p(\d+) y=([\d.]+) x=([\d.]+)-([\d.]+)/.exec(line)!;
    expect(Number(y)).toBeGreaterThan(0);
    expect(Number(y)).toBeLessThan(1);

    const res = await t.edit.execute(
      { id: a.id, place: [{ page: Number(page), x: Number(x1) + 0.01, y: Number(y), text: "Darius" }] },
      t.ctx,
    );
    expect(res.ok).toBe(true);
    const after = await pdfLayout(t.store.readBytes(a.id)!);
    // Same line as the label, not a line of its own above or below it.
    expect(after.split("\n").find((l) => l.includes("Nume și prenume"))).toContain("Darius");
  });

  test("a bad position is refused with the rules, not written off the page", async () => {
    const t = setup();
    const a = t.store.create({ kind: "pdf", title: "C", content: await pdfFromMarkdown("x", "x"), workspaceId: t.ws, sessionId: "s" });
    const res = await t.edit.execute({ id: a.id, place: [{ page: 1, x: 40, y: 0.5, text: "oops" }] }, t.ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain("fractions between 0 and 1");
    expect(await pdfText(t.store.readBytes(a.id)!)).not.toContain("oops");
  });
});

describe("a Word form", () => {
  const docx = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      '<w:document><w:body><w:p><w:r><w:t xml:space="preserve">Nume: </w:t></w:r><w:r><w:t>..........</w:t></w:r></w:p></w:body></w:document>',
    ),
  });

  test("reads as text and fills by find/replace", async () => {
    const t = setup();
    const a = t.store.create({ kind: "docx", title: "Anexa", content: docx, workspaceId: t.ws, sessionId: "s" });
    expect((await t.read.execute({ id: a.id }, t.ctx)).content).toBe("Nume: ..........");
    const res = await t.edit.execute({ id: a.id, find: "..........", replace: "Darius Popescu" }, t.ctx);
    expect(res.ok).toBe(true);
    expect(docxText(t.store.readBytes(a.id)!)).toBe("Nume: Darius Popescu");
  });

  test("a whole rewrite is refused, because it would lose the layout", async () => {
    const t = setup();
    const a = t.store.create({ kind: "docx", title: "Anexa", content: docx, workspaceId: t.ws, sessionId: "s" });
    const res = await t.edit.execute({ id: a.id, content: "new text" }, t.ctx);
    expect(res.ok).toBe(false);
    expect(docxText(t.store.readBytes(a.id)!)).toBe("Nume: ..........");
  });
});
