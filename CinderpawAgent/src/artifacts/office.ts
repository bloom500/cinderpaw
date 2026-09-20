/**
 * Word and Excel files written from what the agent already makes.
 *
 * `artifact_export` could produce a PDF or the artifact's own format and
 * nothing else; asked for a .xlsx it wrote the source bytes under that name
 * and said "exported" (Astra, D1, 20 Sep 2026). Now:
 *
 *  - markdown → .docx through `docx` (MIT): headings, paragraphs, bullets,
 *    numbered lists, rules, code blocks, and **bold** / *italic* / `code`
 *    runs. The same structure `pdfFromMarkdown` renders, so the Word file
 *    and the PDF of one document say the same thing.
 *  - rows → .xlsx through `exceljs` (MIT): a `table` artifact (JSON rows) or
 *    a markdown table becomes one sheet with a bold header row, real numbers
 *    where a cell is a number, and columns wide enough to read.
 *
 * Both libraries are dependencies, not vendored files: the OOXML they write
 * is a format Word and Excel are strict about, and a hand-rolled writer that
 * is one attribute off opens as "the file is corrupt".
 */
import {
  AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun,
} from "docx";
import ExcelJS from "exceljs";

/** Inline markdown into runs: **bold**, *italic*, `code`. Nothing nested. */
function runs(text: string): TextRun[] {
  const out: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(new TextRun(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(new TextRun({ text: tok.slice(2, -2), bold: true }));
    else if (tok.startsWith("`")) out.push(new TextRun({ text: tok.slice(1, -1), font: "Consolas" }));
    else out.push(new TextRun({ text: tok.slice(1, -1), italics: true }));
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(new TextRun(text.slice(last)));
  return out;
}

export async function docxFromMarkdown(markdown: string, title: string): Promise<Uint8Array> {
  const paragraphs: Paragraph[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("```")) { inCode = !inCode; continue; }
    if (inCode) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: raw, font: "Consolas", size: 20 })] }));
      continue;
    }
    if (!t) continue;
    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][h[1]!.length - 1]!;
      paragraphs.push(new Paragraph({ heading: level, children: runs(h[2]!) }));
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      paragraphs.push(new Paragraph({ border: { bottom: { style: "single", size: 6, color: "BBBBBB" } }, children: [] }));
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(t);
    if (li) {
      paragraphs.push(new Paragraph({ bullet: { level: 0 }, children: runs(li[1]!) }));
      continue;
    }
    const ol = /^(\d+)[.)]\s+(.*)$/.exec(t);
    if (ol) {
      paragraphs.push(new Paragraph({ numbering: { reference: "numbered", level: 0 }, children: runs(ol[2]!) }));
      continue;
    }
    paragraphs.push(new Paragraph({ children: runs(t), alignment: AlignmentType.LEFT }));
  }
  const doc = new Document({
    title,
    creator: "Cinderpaw",
    numbering: {
      config: [{ reference: "numbered", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }] }],
    },
    sections: [{ children: paragraphs }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** A cell as Excel should hold it: a number when it reads as one, else text. */
function cell(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * Rows from what a `table` artifact holds. Accepts an array of objects (the
 * keys become the header), an array of arrays (first row is the header), or
 * `{ columns, rows }`. Anything else is a single-cell sheet with the text,
 * because a wrong sheet is still better than a file that will not open.
 */
export function tableRows(content: string): { header: string[]; rows: unknown[][] } {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { parsed = null; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as { columns?: unknown; rows?: unknown };
    if (Array.isArray(o.columns) && Array.isArray(o.rows)) {
      return { header: o.columns.map(String), rows: o.rows.map((r) => (Array.isArray(r) ? r : Object.values(r as object))) };
    }
  }
  if (Array.isArray(parsed) && parsed.length > 0) {
    if (Array.isArray(parsed[0])) return { header: (parsed[0] as unknown[]).map(String), rows: parsed.slice(1) as unknown[][] };
    if (typeof parsed[0] === "object" && parsed[0] !== null) {
      const header = Array.from(new Set(parsed.flatMap((r) => Object.keys(r as object))));
      return { header, rows: parsed.map((r) => header.map((k) => (r as Record<string, unknown>)[k])) };
    }
  }
  const md = markdownTable(content);
  if (md) return md;
  return { header: ["value"], rows: [[content]] };
}

/** The first pipe table in a markdown text, or null. */
function markdownTable(text: string): { header: string[]; rows: unknown[][] } | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (lines.length < 2 || !/^\|?\s*:?-{2,}/.test(lines[1]!.replace(/\|/g, "").trim().replace(/^:/, "-"))) return null;
  const split = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  return { header: split(lines[0]!), rows: lines.slice(2).map(split) };
}

export async function xlsxFromRows(header: string[], rows: unknown[][], sheet = "Sheet1"): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Cinderpaw";
  const ws = wb.addWorksheet(sheet.slice(0, 31) || "Sheet1");
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r.map(cell));
  ws.columns.forEach((col, i) => {
    const widths = [header[i] ?? "", ...rows.map((r) => String(r[i] ?? ""))].map((s) => s.length);
    col.width = Math.min(60, Math.max(8, Math.max(...widths) + 2));
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
