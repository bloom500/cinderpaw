/**
 * Word documents as artifacts: read, changed by the agent, previewed.
 *
 * Official forms arrive as .docx as often as .pdf, and a form is only useful if
 * the file that comes back out is still the form: same layout, same tables,
 * same fonts. So nothing here converts a document to something else and back.
 * The file is kept as it came, and a change touches only the text inside the
 * paragraph it lands in.
 *
 * A .docx is a zip; the text lives in `word/document.xml` as runs (`<w:r>`)
 * inside paragraphs (`<w:p>`), and Word splits a sentence across runs wherever
 * formatting, spell-check or an edit history happened to break it. "Nume:
 * ........" may be three runs. A replace first looks for the text inside one run
 * and changes only that node; only when it is split across runs does it join the
 * paragraph's text and write it back into the first text node, and never across
 * a tab or a line break, which would move the form's alignment.
 *
 * ponytail: regex over the XML, not a DOM. `<w:t>` holds escaped text only, and
 * matching innermost paragraphs handles text boxes (a paragraph inside a
 * paragraph). Cost of the joined case: that paragraph keeps its first run's
 * formatting for all of its text. Upgrade to a real XML parser if forms with
 * mixed formatting inside one field line show up.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const DOCUMENT = "word/document.xml";

/** A zip whose `word/document.xml` exists. */
export function isDocx(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  try {
    return DOCUMENT in unzipSync(bytes, { filter: (f) => f.name === DOCUMENT });
  } catch {
    return false;
  }
}

function documentXml(bytes: Uint8Array): { files: Record<string, Uint8Array>; xml: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("That file is not a readable Word document.");
  }
  const doc = files[DOCUMENT];
  if (!doc) throw new Error("That file is not a readable Word document.");
  return { files, xml: strFromU8(doc) };
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Innermost paragraphs: a `<w:p>` with no `<w:p>` inside it. */
const PARAGRAPH = /<w:p\b[^>]*?(?:\/>|>(?:(?!<w:p\b)[\s\S])*?<\/w:p>)/g;
const TEXT = /<w:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)/g;

function paragraphText(p: string): string {
  let out = "";
  for (const m of p.matchAll(/<w:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g)) {
    if (m[0].startsWith("<w:tab")) out += "\t";
    else if (m[0].startsWith("<w:br")) out += "\n";
    else out += unescapeXml(m[1] ?? "");
  }
  return out;
}

/** The document's text, one paragraph per line. What the agent reads. */
export function docxText(bytes: Uint8Array): string {
  const { xml } = documentXml(bytes);
  return Array.from(xml.matchAll(PARAGRAPH), (m) => paragraphText(m[0])).join("\n").trim();
}

/**
 * Replace the first occurrence of `find` with `replace`, inside one paragraph.
 * Returns null when no single paragraph contains `find`.
 */
export function docxReplace(bytes: Uint8Array, find: string, replace: string): Uint8Array | null {
  if (!find) return null;
  const { files, xml } = documentXml(bytes);
  let done = false;
  const next = xml.replace(PARAGRAPH, (p) => {
    if (done) return p;
    // Best case: the text sits inside one run. Change only that text node, and
    // every run keeps its own formatting.
    let inOneRun = false;
    const single = p.replace(TEXT, (node, inner: string | undefined) => {
      if (inOneRun || inner === undefined) return node;
      const text = unescapeXml(inner);
      if (!text.includes(find)) return node;
      inOneRun = true;
      return `<w:t xml:space="preserve">${escapeXml(text.replace(find, replace))}</w:t>`;
    });
    if (inOneRun) {
      done = true;
      return single;
    }
    // Split across runs. Joining is only safe when nothing sits between the
    // runs: a tab or a line break would end up after all of the text, and the
    // form's alignment with it.
    if (/<w:tab\b|<w:br\b/.test(p)) return p;
    const plain = Array.from(p.matchAll(TEXT), (m) => unescapeXml(m[1] ?? "")).join("");
    if (!plain.includes(find)) return p;
    done = true;
    const rewritten = plain.replace(find, replace);
    let first = true;
    return p.replace(TEXT, () => {
      if (!first) return '<w:t xml:space="preserve"></w:t>';
      first = false;
      return `<w:t xml:space="preserve">${escapeXml(rewritten)}</w:t>`;
    });
  });
  if (!done) return null;
  files[DOCUMENT] = strToU8(next);
  // Word requires [Content_Types].xml to stay the first entry; zipSync keeps
  // insertion order, and unzipSync returned the entries in file order.
  return zipSync(files as Zippable, { level: 6 });
}

/**
 * A readable preview as HTML: paragraphs, headings and tables. Not a rendering
 * of the document's look, and it says so to nobody because it is only ever
 * shown inside the panel's sandboxed frame, next to an Export of the real file.
 */
export function docxPreviewHtml(bytes: Uint8Array): string {
  const { xml } = documentXml(bytes);
  const body = xml.slice(xml.indexOf("<w:body"), xml.lastIndexOf("</w:body>"));
  const out: string[] = [];
  const tokens = /<(\/?)w:(tbl|tr|tc|p)\b[^>]*?(\/?)>|<w:pStyle\b[^>]*w:val="([^"]*)"|<w:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  let para: { style: string; text: string } | null = null;
  for (const m of body.matchAll(tokens)) {
    const [whole, close, tag, selfClose, style, text] = m;
    if (tag === "tbl") out.push(close ? "</table>" : "<table>");
    else if (tag === "tr") out.push(close ? "</tr>" : "<tr>");
    else if (tag === "tc") out.push(close ? "</td>" : "<td>");
    else if (tag === "p") {
      if (!close && !selfClose) para = { style: "", text: "" };
      else if (para) {
        const h = /^Heading([1-3])$|^Titlu([1-3])$/i.exec(para.style);
        const level = h ? h[1] ?? h[2] : null;
        const inner = escapeXml(para.text).replace(/\n/g, "<br>") || "&nbsp;";
        out.push(level ? `<h${level}>${inner}</h${level}>` : `<p>${inner}</p>`);
        para = null;
      }
    } else if (style !== undefined && para) para.style = style;
    else if (whole.startsWith("<w:tab") && para) para.text += "\t";
    else if (whole.startsWith("<w:br") && para) para.text += "\n";
    else if (whole.startsWith("<w:t") && para) para.text += unescapeXml(text ?? "");
  }
  return (
    "<!doctype html><meta charset=utf-8><style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#111}" +
    "table{border-collapse:collapse;margin:8px 0}td{border:1px solid #bbb;padding:4px 6px;vertical-align:top}" +
    "p{margin:0 0 6px;white-space:pre-wrap}</style>" +
    out.join("")
  );
}
