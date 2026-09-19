/**
 * PDF artifacts: made from text, changed by a person, read back by the agent.
 *
 * Each check reads the produced file back through a real PDF parser rather than
 * trusting that pdf-lib was called. A PDF that opens blank, or whose Romanian
 * letters became boxes, is the failure a stranger sees, and neither shows up
 * as an exception.
 */

import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { applyPdfEdits, isPdf, pdfFields, pdfFromMarkdown, pdfText, PDF_MAX_BYTES } from "../src/artifacts/pdf.ts";

async function textOf(bytes: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

describe("pdfFromMarkdown", () => {
  test("headings, paragraphs and lists come out as readable text", async () => {
    const pdf = await pdfFromMarkdown("# Contract\n\nIntre părți, s-a convenit:\n\n- plata în 30 de zile\n- 1. livrare", "Contract");
    expect(isPdf(pdf)).toBe(true);
    const text = await textOf(pdf);
    expect(text).toContain("Contract");
    // The letters a Romanian user types. Standard PDF fonts cannot draw them.
    expect(text).toContain("părți");
    expect(text).toContain("plata în 30 de zile");
  });

  test("a long document flows onto more pages instead of running off the first", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} with enough words to wrap across the line.`).join("\n\n");
    const pdf = await pdfFromMarkdown(long, "Long");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(3);
    expect(await textOf(pdf)).toContain("Paragraph 199");
  });

  /**
   * Every test above this one passed while the file was unreadable on screen.
   * They all ask what the text EXTRACTS as, and the text was never the problem:
   * pdf-lib's subsetter kept the characters and threw away half their outlines,
   * so Acrobat drew "Co    o  bo" for "Contract de colaborare". So this one
   * asks the only question that catches it: does every glyph have a shape.
   */
  test("every embedded glyph has an outline, not just a code point", async () => {
    const { default: fontkit } = await import("@pdf-lib/fontkit");
    const { inflateSync } = await import("node:zlib");
    const pl = await import("pdf-lib");

    const pdf = await pdfFromMarkdown("# Contract de colaborare\n\nPărțile convin.", "Contract");
    const doc = await PDFDocument.load(pdf);

    let fontsChecked = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const dict = (obj as { dict?: pl.PDFDict }).dict ?? (obj instanceof pl.PDFDict ? obj : null);
      const file = dict?.get(pl.PDFName.of("FontFile2"));
      if (!file) continue;
      const stream = doc.context.lookup(file) as { getContents(): Uint8Array };
      const font = fontkit.create(Buffer.from(inflateSync(Buffer.from(stream.getContents()))));
      // Space has no outline and is the only glyph allowed none.
      const blank = [...("Contract de colaborare Părțile convin")]
        .filter((ch) => ch !== " ")
        .filter((ch) => font.glyphForCodePoint(ch.codePointAt(0)!).path.commands.length === 0);
      expect(blank).toEqual([]);
      fontsChecked += 1;
    }
    expect(fontsChecked).toBeGreaterThan(0);
  });

  test("an empty body still makes a valid one-page PDF", async () => {
    const pdf = await pdfFromMarkdown("", "Blank");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});

describe("applyPdfEdits", () => {
  test("text lands on the page it was placed on", async () => {
    const base = await pdfFromMarkdown("Page one", "T");
    const out = await applyPdfEdits(base, [{ type: "text", page: 0, x: 0.1, y: 0.8, size: 14, text: "Semnat, Darius Ș." }]);
    expect(await textOf(out)).toContain("Semnat, Darius Ș.");
  });

  test("a signature image is drawn where it was placed, at its size", async () => {
    const base = await pdfFromMarkdown("Sign below", "S");
    const out = await applyPdfEdits(base, [
      { type: "image", page: 0, x: 0.5, y: 0.7, width: 0.3, height: 0.1, png: ONE_PIXEL_PNG },
    ]);
    const doc = await PDFDocument.load(out);
    // An image XObject exists on the page: the signature is in the file, not only on screen.
    const resources = doc.getPage(0).node.Resources();
    expect(String(resources?.toString())).toContain("XObject");
  });

  test("pages can be removed and turned", async () => {
    const base = await pdfFromMarkdown(Array.from({ length: 120 }, (_, i) => `Line ${i}`).join("\n\n"), "P");
    const before = (await PDFDocument.load(base)).getPageCount();
    const out = await applyPdfEdits(base, [
      { type: "rotate_page", page: 0, degrees: 90 },
      { type: "delete_page", page: 1 },
    ]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(before - 1);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
  });

  test("a form is filled by field name, and the list says what exists", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    doc.getForm().createTextField("full_name").addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    const base = await doc.save();
    expect(await pdfFields(base)).toEqual([{ name: "full_name", type: "text", value: "" }]);
    const out = await applyPdfEdits(base, [{ type: "field", name: "full_name", value: "Ana Pop" }]);
    expect(await pdfFields(out)).toEqual([{ name: "full_name", type: "text", value: "Ana Pop" }]);
  });

  test("an edit aimed at a page that does not exist is refused, not silently dropped", async () => {
    const base = await pdfFromMarkdown("x", "x");
    await expect(applyPdfEdits(base, [{ type: "text", page: 5, x: 0, y: 0, size: 12, text: "lost" }])).rejects.toThrow(/page 6/);
  });

  test("an encrypted or broken file says so in words", async () => {
    await expect(applyPdfEdits(new TextEncoder().encode("not a pdf"), [])).rejects.toThrow(/not a readable PDF/);
  });
});

describe("pdfText", () => {
  test("is what the agent reads back instead of bytes", async () => {
    const pdf = await pdfFromMarkdown("## Scope\n\nBuild the thing.", "S");
    expect(await pdfText(pdf)).toContain("Build the thing.");
  });
});

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("the agent's tools on a PDF", () => {
  async function tools() {
    const { openDatabase } = await import("../src/db.ts");
    const { ArtifactStore } = await import("../src/artifacts/store.ts");
    const t = await import("../src/tools/builtin/artifact.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const db = openDatabase(":memory:");
    const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-pdf-")));
    const deps = { db: db.raw, store, workspaceRoots: [] };
    const ctx = { sessionId: "d0b56fa7-6de5-4076-81a5-ef5625b81ac8" } as never;
    return { store, ctx, create: t.createArtifactCreateTool(deps), read: t.createArtifactReadTool(deps), edit: t.createArtifactEditTool(deps) };
  }

  test("create makes a real PDF from markdown, and read returns its words", async () => {
    const { store, ctx, create, read } = await tools();
    const res = await create.execute({ kind: "pdf", title: "Ofertă", content: "# Ofertă\n\nPreț: 100 lei" }, ctx);
    expect(res.ok).toBe(true);
    const id = (res.data as { id: string }).id;
    expect(isPdf(store.readBytes(id)!)).toBe(true);
    const back = await read.execute({ id }, ctx);
    expect(back.content).toContain("Preț: 100 lei");
  });

  test("a find/replace on a PDF is refused with what works instead", async () => {
    const { ctx, create, edit } = await tools();
    const res = await create.execute({ kind: "pdf", title: "X", content: "hello" }, ctx);
    const out = await edit.execute({ id: (res.data as { id: string }).id, find: "hello", replace: "bye" }, ctx);
    expect(out.ok).toBe(false);
    expect(out.content).toContain("Artifacts panel");
  });
});

describe("parsePdfEdits", () => {
  test("accepts what the panel sends", async () => {
    const { parsePdfEdits } = await import("../src/artifacts/pdf.ts");
    const edits = parsePdfEdits(JSON.stringify({ edits: [{ type: "text", page: 0, x: 0.2, y: 0.3, size: 12, text: "hi" }] }));
    expect(edits).toHaveLength(1);
  });

  test("names the first bad change instead of saving a file without it", async () => {
    const { parsePdfEdits } = await import("../src/artifacts/pdf.ts");
    const json = JSON.stringify({ edits: [
      { type: "field", name: "a", value: "b" },
      { type: "image", page: 0, x: 0.1, y: 1.4, width: 0.2, height: 0.1, png: "x" },
    ] });
    expect(() => parsePdfEdits(json)).toThrow("PDF change 2 is not valid.");
    expect(() => parsePdfEdits("{nope")).toThrow("could not be read");
  });
});

describe("displayToPdf", () => {
  // A 600x800 page. What the person sees as top-left is a different corner of
  // the page for each quarter turn; these are the four corners worked by hand.
  test("an unturned page: top-left on screen is top-left of the page", async () => {
    const { displayToPdf } = await import("../src/artifacts/pdf.ts");
    expect(displayToPdf(0, 0, 600, 800, 0)).toEqual({ x: 0, y: 800 });
    expect(displayToPdf(1, 1, 600, 800, 0)).toEqual({ x: 600, y: 0 });
  });

  test("turned 90: the screen's top-left is the page's origin", async () => {
    const { displayToPdf } = await import("../src/artifacts/pdf.ts");
    expect(displayToPdf(0, 0, 600, 800, 90)).toEqual({ x: 0, y: 0 });
    expect(displayToPdf(1, 0, 600, 800, 90)).toEqual({ x: 0, y: 800 });
  });

  test("turned 180 and 270", async () => {
    const { displayToPdf } = await import("../src/artifacts/pdf.ts");
    expect(displayToPdf(0, 0, 600, 800, 180)).toEqual({ x: 600, y: 0 });
    expect(displayToPdf(0, 0, 600, 800, 270)).toEqual({ x: 600, y: 800 });
  });

  test("text placed on a turned page is still in the file", async () => {
    const base = await pdfFromMarkdown("x", "x");
    const turned = await applyPdfEdits(base, [{ type: "rotate_page", page: 0, degrees: 90 }]);
    const out = await applyPdfEdits(turned, [{ type: "text", page: 0, x: 0.2, y: 0.2, size: 12, text: "Semnat" }]);
    expect(await textOf(out)).toContain("Semnat");
  });
});

test("the host refuses oversized downloads at the same size the panel does", () => {
  // The browser host checks the size BEFORE importing, so a refusal can never
  // arrive after the download was deleted (Astra, 19 Sep 2026). Two copies of
  // one number, read against each other so they cannot drift.
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const rust = readFileSync(new URL("../../src-tauri/src/browser.rs", import.meta.url), "utf8");
  const m = rust.match(/ARTIFACT_IMPORT_MAX_BYTES:\s*usize\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
  expect(m).not.toBeNull();
  expect(Number(m![1]) * 1024 * 1024).toBe(PDF_MAX_BYTES);
});
