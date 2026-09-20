/**
 * Word and Excel out of the agent's artifacts. Each file is written, then
 * read back by an independent reader: a file that only our writer thinks is
 * valid is the "corrupt file" dialog on someone else's machine.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { docxText, isDocx } from "../src/artifacts/docx.ts";
import { docxFromMarkdown, tableRows, xlsxFromRows } from "../src/artifacts/office.ts";
import { createArtifactCreateTool, createArtifactExportTool } from "../src/tools/builtin/artifact.ts";

describe("docxFromMarkdown", () => {
  test("headings, lists, code and inline marks survive the trip, readable by our own docx reader", async () => {
    const md = "# Raport\n\nText cu **bold** si *italic* si `cod`.\n\n- unu\n- doi\n\n1. primul\n2. al doilea\n\n```\nlet x = 1;\n```\n";
    const bytes = await docxFromMarkdown(md, "Raport");
    expect(isDocx(bytes)).toBe(true);
    const text = docxText(bytes);
    for (const s of ["Raport", "bold", "italic", "cod", "unu", "doi", "primul", "al doilea", "let x = 1;"]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("**");
    expect(text).not.toContain("```");
  });
});

describe("xlsxFromRows", () => {
  test("numbers are numbers, header is bold, Excel reads it back", async () => {
    const bytes = await xlsxFromRows(["Nume", "Suma"], [["Ana", "12.5"], ["Ion", 7]], "Plati");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as Buffer);
    const ws = wb.getWorksheet("Plati")!;
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.getCell("A1").value).toBe("Nume");
    expect(ws.getCell("B2").value).toBe(12.5);
    expect(ws.getCell("B3").value).toBe(7);
    expect(ws.getCell("A3").value).toBe("Ion");
  });

  test("tableRows understands objects, arrays, {columns, rows} and a markdown table", () => {
    expect(tableRows('[{"a":1,"b":"x"},{"a":2,"b":"y"}]')).toEqual({ header: ["a", "b"], rows: [[1, "x"], [2, "y"]] });
    expect(tableRows('[["h1","h2"],[1,2]]')).toEqual({ header: ["h1", "h2"], rows: [[1, 2]] });
    expect(tableRows('{"columns":["c"],"rows":[[3]]}')).toEqual({ header: ["c"], rows: [[3]] });
    expect(tableRows("# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")).toEqual({ header: ["a", "b"], rows: [["1", "2"]] });
    expect(tableRows("no table here")).toEqual({ header: ["value"], rows: [["no table here"]] });
  });
});

describe("artifact_export writes .docx and .xlsx, still refuses .pptx", () => {
  test("end to end through the tool", async () => {
    const db = openDatabase(":memory:");
    const out = mkdtempSync(join(tmpdir(), "cinderpaw-office-out-"));
    const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-office-")));
    const deps = { db: db.raw, store, workspaceRoots: [out] };
    const ctx = { sessionId: "d0b56fa7-6de5-4076-81a5-ef5625b81ac8" } as never;
    const create = createArtifactCreateTool(deps);
    const exp = createArtifactExportTool(deps);

    const doc = await create.execute({ kind: "markdown", title: "Memo", content: "# Memo\n\nHello **world**." }, ctx);
    const docId = (doc.data as { id: string }).id;
    const r1 = await exp.execute({ id: docId, format: "docx" }, ctx);
    expect(r1.ok).toBe(true);
    const docxPath = (r1.data as { path: string }).path;
    expect(docxPath.endsWith(".docx")).toBe(true);
    expect(docxText(new Uint8Array(readFileSync(docxPath)))).toContain("world");

    const tbl = await create.execute({ kind: "table", title: "Vanzari", content: '[{"luna":"ian","suma":10},{"luna":"feb","suma":20}]' }, ctx);
    const tblId = (tbl.data as { id: string }).id;
    const r2 = await exp.execute({ id: tblId, dest: join(out, "vanzari.xlsx") }, ctx);
    expect(r2.ok).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(out, "vanzari.xlsx"));
    expect(wb.worksheets[0]!.getCell("B3").value).toBe(20);

    const r3 = await exp.execute({ id: docId, dest: join(out, "wrong.pptx") }, ctx);
    expect(r3.ok).toBe(false);
    expect(r3.error).toBe("unsupported_format");
    expect(r3.content).toContain(".docx");
    expect(existsSync(join(out, "wrong.pptx"))).toBe(false);
  });
});
