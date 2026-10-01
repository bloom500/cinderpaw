/**
 * Boards (spec 2026-10-01): the agent sends blocks, the app draws them. What
 * the sidecar owes the app is a board it can trust: every block it stores fits
 * its shape, a block that does not is named back to the agent, and a board that
 * cannot be drawn at all is refused rather than saved as a blank.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { artifactFile } from "../src/artifacts/export.ts";
import { docxText } from "../src/artifacts/docx.ts";
import { boardToMarkdown, validateBoard, validateBlock } from "../src/artifacts/board.ts";
import { createArtifactCreateTool, createArtifactEditTool } from "../src/tools/builtin/artifact.ts";

const PERF = {
  title: "Performance Charts", subtitle: "Monthly metrics", icon: "bar-chart",
  blocks: [
    { kind: "kpis", items: [{ label: "Total Growth", value: "+28%", delta: "vs. previous period", trend: "up" }, { label: "CTR", value: "4.8%" }] },
    { kind: "line", title: "Website traffic", x: ["Apr 1", "Apr 5", "Apr 10"], series: [{ name: "Sessions", values: [2000, "3K", 4500] }] },
    { kind: "bars", title: "Top channels", items: [{ label: "Organic", value: "42K" }, { label: "Paid", value: 28000 }] },
    { kind: "breakdown", title: "Channel breakdown", items: [{ label: "Organic", value: 42 }, { label: "Paid", value: 28 }] },
    { kind: "flow", nodes: [{ id: "a", title: "Inputs", icon: "file" }, { id: "b", title: "Logic", icon: "brain" }], edges: [{ from: "a", to: "b" }, { from: "a", to: "zz" }] },
    { kind: "sparkle-cannon", items: [] },
  ],
};

function setup() {
  const db = openDatabase(":memory:");
  const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-board-")));
  const deps = { db: db.raw, store, workspaceRoots: [] };
  return { store, create: createArtifactCreateTool(deps), edit: createArtifactEditTool(deps) };
}
const ctx = { sessionId: "d0b56fa7-6de5-4076-81a5-ef5625b81ac8" } as never;

describe("validateBoard", () => {
  test("keeps the blocks that fit, normalises values a model writes as text, names the rest", () => {
    const { board, dropped } = validateBoard(JSON.stringify(PERF));
    expect(board!.blocks.map((b) => b.kind)).toEqual(["kpis", "line", "bars", "breakdown", "flow"]);
    expect((board!.blocks[1] as { series: { values: number[] }[] }).series[0].values).toEqual([2000, 3000, 4500]);
    expect((board!.blocks[2] as { items: { value: number }[] }).items[0].value).toBe(42000);
    // An edge to a node that does not exist is dropped, the flow is kept.
    expect((board!.blocks[4] as { edges: unknown[] }).edges).toHaveLength(1);
    expect(dropped).toEqual(["#6 (sparkle-cannon)"]);
  });

  test("an icon outside the list and an image that is not https are left out, not trusted", () => {
    expect(validateBlock({ kind: "columns", items: [{ title: "A", icon: "skull", image: "http://x/a.jpg" }, { title: "B" }] }))
      .toEqual({ kind: "columns", items: [{ title: "A", points: [] }, { title: "B", points: [] }] });
  });

  test("not JSON, or no block that fits, is refused with the reason", () => {
    expect(validateBoard("{nope").error).toContain("not JSON");
    expect(validateBoard({ blocks: [{ kind: "kpis", items: [] }] }).error).toBe("no block fits its shape");
  });
});

describe("artifact_create and artifact_edit with a board", () => {
  test("stores the normalised board and tells the agent which blocks were left out", async () => {
    const { create, store } = setup();
    const r = await create.execute({ kind: "board", title: "Perf", content: JSON.stringify(PERF) }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("#6 (sparkle-cannon)");
    const id = (r.data as { id: string }).id;
    expect(JSON.parse(store.read(id)!).blocks).toHaveLength(5);
  });

  test("a board that cannot be drawn is refused, nothing is saved", async () => {
    const { create, store } = setup();
    const r = await create.execute({ kind: "board", title: "Bad", content: "not json" }, ctx);
    expect(r.ok).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  test("an edit that breaks the JSON is refused, the board stays as it was", async () => {
    const { create, edit, store } = setup();
    const r = await create.execute({ kind: "board", title: "Perf", content: JSON.stringify(PERF) }, ctx);
    const id = (r.data as { id: string }).id;
    const bad = await edit.execute({ id, find: '"Performance Charts"', replace: '"Performance Charts' }, ctx);
    expect(bad.ok).toBe(false);
    expect(store.get(id)!.version).toBe(1);
    const good = await edit.execute({ id, find: "Total Growth", replace: "Growth" }, ctx);
    expect(good.ok).toBe(true);
  });
});

describe("export", () => {
  test("a board goes to Word as its words, block by block", async () => {
    const { store } = setup();
    const { board } = validateBoard(PERF);
    const a = store.create({ kind: "board", title: "Perf", content: JSON.stringify(board), workspaceId: "w", sessionId: "s" });
    const text = docxText((await artifactFile(store, a, "docx")).content as Uint8Array);
    expect(text).toContain("Total Growth");
    expect(text).toContain("Website traffic");
    expect(text).toContain("Inputs");
    expect(text).not.toContain('"kind"');
  });

  test("boardToMarkdown shows shares as percentages and links as arrows", () => {
    const md = boardToMarkdown(validateBoard(PERF).board!);
    expect(md).toContain("Organic: 42 (60%)");
    expect(md).toContain("Inputs → Logic");
  });
});
