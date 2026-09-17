/**
 * Word documents: the file that comes back out must still be the form.
 *
 * The fixture is built the way Word actually writes a form line: the label and
 * the dotted blank split across runs with different formatting, a table, and a
 * text box (a paragraph nested inside a paragraph), which is where a naive
 * regex replaces the wrong text.
 */

import { describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { docxPreviewHtml, docxReplace, docxText, isDocx } from "../src/artifacts/docx.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docx(bodyXml: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`),
    "word/styles.xml": strToU8("<w:styles/>"),
  });
}

const FORM = docx(
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Cerere REV 3</w:t></w:r></w:p>' +
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Nume și </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>prenume:</w:t></w:r><w:r><w:t xml:space="preserve"> ..........</w:t></w:r></w:p>' +
  '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>CNP</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>_____</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
  '<w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>Data: ..........</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>',
);

describe("docx", () => {
  test("is recognised, and a zip that is not Word is not", () => {
    expect(isDocx(FORM)).toBe(true);
    expect(isDocx(zipSync({ "a.txt": strToU8("x") }))).toBe(false);
    expect(isDocx(new TextEncoder().encode("%PDF-1.7"))).toBe(false);
  });

  test("reads as one line per paragraph, with runs joined", () => {
    const text = docxText(FORM);
    expect(text).toContain("Nume și prenume: ..........");
    expect(text).toContain("CNP");
    expect(text).toContain("Data: ..........");
  });

  test("fills a blank that Word split across runs, and the rest of the file is untouched", () => {
    const out = docxReplace(FORM, "prenume: ..........", "prenume: Darius Popescu")!;
    expect(docxText(out)).toContain("Nume și prenume: Darius Popescu");
    const files = unzipSync(out);
    expect(Object.keys(files)).toEqual(["[Content_Types].xml", "word/document.xml", "word/styles.xml"]);
    expect(strFromU8(files["word/styles.xml"]!)).toBe("<w:styles/>");
    // The table and the heading were not rewritten.
    expect(strFromU8(files["word/document.xml"]!)).toContain('<w:pStyle w:val="Heading1"/>');
  });

  test("a blank inside a text box is filled in the text box, not in the paragraph around it", () => {
    const out = docxReplace(FORM, "Data: ..........", "Data: 17.09.2026")!;
    expect(docxText(out)).toContain("Data: 17.09.2026");
    expect(strFromU8(unzipSync(out)["word/document.xml"]!)).toContain("<w:txbxContent>");
  });

  test("text that is not there changes nothing and says so", () => {
    expect(docxReplace(FORM, "Adresa:", "x")).toBeNull();
  });

  test("characters that mean something in XML are written as text", () => {
    const out = docxReplace(FORM, "..........", "A & B <srl>")!;
    expect(docxText(out)).toContain("A & B <srl>");
  });

  test("previews headings, paragraphs and the table as HTML, with nothing executable", () => {
    const html = docxPreviewHtml(FORM);
    expect(html).toContain("<h1>Cerere REV 3</h1>");
    expect(html).toContain("<td><p>CNP</p></td>");
    const evil = docx('<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>');
    expect(docxPreviewHtml(evil)).not.toContain("<script>");
  });
});

describe("docx replace keeps what it can", () => {
  test("text inside one run keeps that run's formatting and its neighbours'", () => {
    const f = docx('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Nume: </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>..........</w:t></w:r></w:p>');
    const xml = strFromU8(unzipSync(docxReplace(f, "..........", "Ana")!)["word/document.xml"]!);
    expect(xml).toContain('<w:b/></w:rPr><w:t xml:space="preserve">Nume: </w:t>');
    expect(xml).toContain('<w:i/></w:rPr><w:t xml:space="preserve">Ana</w:t>');
  });

  test("a line with a tab is never joined around the tab", () => {
    const f = docx('<w:p><w:r><w:t>Nu</w:t></w:r><w:r><w:t>me:</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>....</w:t></w:r></w:p>');
    expect(docxReplace(f, "Nume:", "Name:")).toBeNull();
    expect(docxText(docxReplace(f, "....", "Ana")!)).toBe("Nume:\tAna");
  });
});
