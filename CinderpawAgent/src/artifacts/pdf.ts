/**
 * PDF artifacts: made from text by the agent, changed on the page by a person.
 *
 * Two things this is and one thing it is not.
 *
 * It MAKES a PDF from the markdown the agent already writes well (headings,
 * paragraphs, lists), laid out on A4 with page breaks. It APPLIES what a person
 * did in the panel: text placed on a page, a drawn signature, pages removed or
 * turned, form fields filled. It does NOT rewrite text already in a PDF. A PDF
 * has no paragraphs, only glyphs at coordinates; "change this sentence" means
 * reconstructing layout and fonts, which is exactly the work the plan deferred.
 *
 * Fonts. The 14 standard PDF fonts only cover Windows-1252, so "părți" or "Ș"
 * either throws or turns into boxes, on the first Romanian document anyone
 * makes. Noto Sans (OFL) is bundled and embedded as a subset, so a generated
 * file carries only the glyphs it uses.
 *
 * Coordinates cross the wire as fractions of the page, origin top-left, because
 * that is what the panel measures on screen at whatever zoom. PDF space is
 * points from the bottom-left; the conversion happens here, once.
 */

import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import regularFontPath from "./vendor/fonts/NotoSans-Regular.ttf" with { type: "file" };
import boldFontPath from "./vendor/fonts/NotoSans-Bold.ttf" with { type: "file" };

/** Every file starts with this; checked before handing bytes to a parser. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

export type PdfEdit =
  | { type: "text"; page: number; x: number; y: number; size: number; text: string }
  | { type: "image"; page: number; x: number; y: number; width: number; height: number; png: string }
  | { type: "delete_page"; page: number }
  | { type: "rotate_page"; page: number; degrees: number }
  | { type: "field"; name: string; value: string };

export interface PdfField {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radio" | "other";
  value: string;
}

async function fonts(doc: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont }> {
  doc.registerFontkit(fontkit);
  const [r, b] = await Promise.all([Bun.file(regularFontPath).arrayBuffer(), Bun.file(boldFontPath).arrayBuffer()]);
  return {
    regular: await doc.embedFont(r, { subset: true }),
    bold: await doc.embedFont(b, { subset: true }),
  };
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  if (!isPdf(bytes)) throw new Error("That file is not a readable PDF.");
  try {
    return await PDFDocument.load(bytes);
  } catch (e) {
    // pdf-lib's own message is about object streams and xref tables.
    const why = String(e).toLowerCase().includes("encrypt") ? " It is password-protected." : "";
    throw new Error(`That file is not a readable PDF.${why}`);
  }
}

// A4 in points, with margins a printed page keeps.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;

/** Split text into lines that fit `width` at `size`, breaking on spaces. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) {
        line = next;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** `**bold**` and `_x_` markers are removed rather than printed; the PDF has no inline styling yet. */
function plain(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)[_*](.+?)[_*](?=\s|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1");
}

/**
 * A PDF from markdown.
 *
 * ponytail: block-level only (headings, paragraphs, bullet and numbered lists,
 * rules). Inline bold/italic and tables are flattened to text. Add inline runs
 * when someone asks for a PDF where that matters.
 */
export async function pdfFromMarkdown(markdown: string, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("Cinderpaw");
  const { regular, bold } = await fonts(doc);
  const width = PAGE_W - MARGIN * 2;

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const ensure = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };
  const block = (text: string, font: PDFFont, size: number, indent = 0, bullet?: string) => {
    const lead = size * 1.4;
    wrap(plain(text), font, size, width - indent).forEach((ln, i) => {
      ensure(lead);
      y -= lead;
      if (bullet && i === 0) page.drawText(bullet, { x: MARGIN + indent - 14, y, size, font });
      page.drawText(ln, { x: MARGIN + indent, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    });
  };

  for (const para of markdown.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    for (const line of para.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const h = /^(#{1,3})\s+(.*)$/.exec(t);
      if (h) {
        const size = [20, 16, 13][h[1]!.length - 1]!;
        y -= size * 0.6;
        block(h[2]!, bold, size);
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(t)) {
        ensure(16);
        y -= 8;
        page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
        y -= 8;
        continue;
      }
      const li = /^[-*]\s+(.*)$/.exec(t);
      if (li) {
        block(li[1]!, regular, 11, 18, "•");
        continue;
      }
      const ol = /^(\d+)[.)]\s+(.*)$/.exec(t);
      if (ol) {
        block(ol[2]!, regular, 11, 18, `${ol[1]}.`);
        continue;
      }
      block(t, regular, 11);
    }
    y -= 6;
  }
  return doc.save();
}

/**
 * A point the person placed on screen, in the page's own coordinates.
 *
 * On screen a page is shown turned by its /Rotate, so "top-left" of what they
 * see is a different corner of the page for each quarter turn. Scanned PDFs are
 * often stored sideways and turned this way, and without this a signature
 * placed at the bottom of one landed somewhere else in the file.
 *
 * `u`, `v` are fractions of the page as displayed, from its top-left. `w`, `h`
 * are the page's unrotated size in points.
 */
export function displayToPdf(u: number, v: number, w: number, h: number, rotation: number): { x: number; y: number } {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { x: v * w, y: u * h };
    case 180:
      return { x: (1 - u) * w, y: v * h };
    case 270:
      return { x: (1 - v) * w, y: (1 - u) * h };
    default:
      return { x: u * w, y: (1 - v) * h };
  }
}

/**
 * Apply what the person did, in order, and return the new file.
 *
 * Deletes are applied last and from the highest page down, whatever order they
 * arrived in: every other edit names pages as the person saw them, and removing
 * page 2 first would move everything after it.
 */
export async function applyPdfEdits(bytes: Uint8Array, edits: PdfEdit[]): Promise<Uint8Array> {
  const doc = await load(bytes);
  const pageCount = doc.getPageCount();
  const pageAt = (n: number): PDFPage => {
    if (!Number.isInteger(n) || n < 0 || n >= pageCount) {
      throw new Error(`There is no page ${n + 1}; this PDF has ${pageCount}.`);
    }
    return doc.getPage(n);
  };
  let font: PDFFont | null = null;

  for (const e of edits) {
    if (e.type === "text") {
      const page = pageAt(e.page);
      font ??= (await fonts(doc)).regular;
      const { width, height } = page.getSize();
      const turn = page.getRotation().angle;
      const shownH = turn % 180 === 0 ? height : width;
      const size = Math.max(4, Math.min(96, e.size));
      // e.y is the top of the box on screen; drawText anchors at the baseline,
      // so the anchor is one line lower, and the text turns with the page so it
      // reads upright the way it was typed.
      const at = displayToPdf(e.x, e.y + size / shownH, width, height, turn);
      page.drawText(e.text, { ...at, size, font, color: rgb(0, 0, 0), rotate: degrees(turn) });
    } else if (e.type === "image") {
      const page = pageAt(e.page);
      const img = await doc.embedPng(Buffer.from(e.png.replace(/^data:image\/png;base64,/, ""), "base64"));
      const { width, height } = page.getSize();
      const turn = page.getRotation().angle;
      const [shownW, shownH] = turn % 180 === 0 ? [width, height] : [height, width];
      // Anchored at the box's bottom-left as shown, which is where drawImage
      // puts the image's own bottom-left before turning it.
      const at = displayToPdf(e.x, e.y + e.height, width, height, turn);
      page.drawImage(img, { ...at, width: e.width * shownW, height: e.height * shownH, rotate: degrees(turn) });
    } else if (e.type === "rotate_page") {
      const page = pageAt(e.page);
      page.setRotation(degrees((((page.getRotation().angle + e.degrees) % 360) + 360) % 360));
    } else if (e.type === "field") {
      const field = doc.getForm().getFieldMaybe(e.name);
      if (!field) throw new Error(`This PDF has no form field named "${e.name}".`);
      if (field instanceof PDFTextField) field.setText(e.value);
      else if (field instanceof PDFCheckBox) (e.value === "true" ? field.check() : field.uncheck());
      else if (field instanceof PDFDropdown) field.select(e.value);
      else if (field instanceof PDFRadioGroup) field.select(e.value);
    } else if (e.type === "delete_page") {
      pageAt(e.page);
    }
  }

  const deletes = edits
    .filter((e): e is Extract<PdfEdit, { type: "delete_page" }> => e.type === "delete_page")
    .map((e) => e.page)
    .sort((a, b) => b - a);
  if (new Set(deletes).size >= pageCount) throw new Error("A PDF needs at least one page; that would remove all of them.");
  for (const p of new Set(deletes)) doc.removePage(p);

  return doc.save();
}

/** The form fields a person can fill, with what they hold now. */
export async function pdfFields(bytes: Uint8Array): Promise<PdfField[]> {
  const doc = await load(bytes);
  return doc.getForm().getFields().map((f) => {
    const name = f.getName();
    if (f instanceof PDFTextField) return { name, type: "text", value: f.getText() ?? "" };
    if (f instanceof PDFCheckBox) return { name, type: "checkbox", value: String(f.isChecked()) };
    if (f instanceof PDFDropdown) return { name, type: "dropdown", value: f.getSelected()[0] ?? "" };
    if (f instanceof PDFRadioGroup) return { name, type: "radio", value: f.getSelected() ?? "" };
    return { name, type: "other", value: "" };
  });
}

/** What the agent reads when it opens a PDF: its text, not its bytes. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).trim();
}

/** Past this a PDF is refused rather than pushed through the stdout pipe as base64. */
export const PDF_MAX_BYTES = 20 * 1024 * 1024;

const fraction = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const pageNo = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * The panel's edits, checked before they touch a file.
 *
 * They come from our own UI, but through a pipe that carries text, and a bad
 * value here does not fail loudly: a NaN coordinate draws nothing and the
 * person's signature silently is not in the saved file. So every field is
 * checked, and the first bad one is named.
 */
export function parsePdfEdits(json: string): PdfEdit[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The PDF changes could not be read.");
  }
  const list = (raw as { edits?: unknown })?.edits;
  if (!Array.isArray(list)) throw new Error("The PDF changes could not be read.");
  return list.map((e: Record<string, unknown>, i): PdfEdit => {
    const bad = () => new Error(`PDF change ${i + 1} is not valid.`);
    switch (e?.type) {
      case "text":
        if (!pageNo(e.page) || !fraction(e.x) || !fraction(e.y) || typeof e.size !== "number" || typeof e.text !== "string") throw bad();
        return { type: "text", page: e.page, x: e.x, y: e.y, size: e.size, text: e.text };
      case "image":
        if (!pageNo(e.page) || !fraction(e.x) || !fraction(e.y) || !fraction(e.width) || !fraction(e.height) || typeof e.png !== "string") throw bad();
        return { type: "image", page: e.page, x: e.x, y: e.y, width: e.width, height: e.height, png: e.png };
      case "delete_page":
        if (!pageNo(e.page)) throw bad();
        return { type: "delete_page", page: e.page };
      case "rotate_page":
        if (!pageNo(e.page) || ![90, 180, 270, -90].includes(e.degrees as number)) throw bad();
        return { type: "rotate_page", page: e.page, degrees: e.degrees as number };
      case "field":
        if (typeof e.name !== "string" || typeof e.value !== "string") throw bad();
        return { type: "field", name: e.name, value: e.value };
      default:
        throw bad();
    }
  });
}
