/**
 * The counter behind the "+71" in the desktop's scratchpad telemetry line.
 *
 * Every case here is one the naive version got wrong.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { lineDelta, isScratchPath, scratchpadBrief } from "../src/tools/file-delta.ts";
import { scratchRoot } from "../src/config.ts";
import { createWriteFileTool } from "../src/tools/builtin/write-file.ts";
import { createEditFileTool } from "../src/tools/builtin/edit-file.ts";

test("creating a file counts every line as added and nothing as removed", () => {
  // The phantom `-1`: "".split("\n") is [""], so an empty before looked like
  // one line that got deleted.
  expect(lineDelta("", "a\nb\nc")).toEqual({ added: 3, removed: 0 });
});

test("an unchanged write is 0/0, not a full rewrite", () => {
  expect(lineDelta("a\nb", "a\nb")).toEqual({ added: 0, removed: 0 });
});

test("appending reports only what was appended", () => {
  expect(lineDelta("a\nb", "a\nb\nc\nd")).toEqual({ added: 2, removed: 0 });
});

test("replacing a line is one added and one removed", () => {
  expect(lineDelta("a\nb\nc", "a\nCHANGED\nc")).toEqual({ added: 1, removed: 1 });
});

test("deleting everything reports the removals", () => {
  expect(lineDelta("a\nb\nc", "")).toEqual({ added: 0, removed: 3 });
});

test("duplicate lines are counted, not collapsed", () => {
  // A set would say "nothing changed" here.
  expect(lineDelta("x\nx", "x\nx\nx")).toEqual({ added: 1, removed: 0 });
});

test("a moved line counts as neither added nor removed", () => {
  // The documented ceiling of the multiset approach, pinned so a future switch
  // to a real diff is a deliberate change rather than a surprise.
  expect(lineDelta("a\nb", "b\na")).toEqual({ added: 0, removed: 0 });
});

test("a path inside the scratch root is scratch", () => {
  expect(isScratchPath(join(scratchRoot(), "notes.md"))).toBe(true);
  expect(isScratchPath(join(scratchRoot(), "deep", "nested", "f.txt"))).toBe(true);
});

test("both write tools tell the model the scratchpad is its own, in the same words", () => {
  // The failure this guards is silent and total: with the directory merely
  // listed among the writable roots, the model reads it as one more permitted
  // path and never writes there — so the telemetry line reads "0 edits" forever
  // and looks like a broken feature rather than an unused one.
  const roots = [scratchRoot(), "D:/Projects/app"];
  const write = createWriteFileTool(roots).manifest.description;
  const edit = createEditFileTool(roots).manifest.description;

  for (const description of [write, edit]) {
    expect(description).toContain(scratchRoot());
    expect(description).toContain("SCRATCHPAD");
  }
  // One source, so the two can never describe the same directory differently
  // inside a single prompt.
  expect(write).toContain(scratchpadBrief());
  expect(edit).toContain(scratchpadBrief());
});

test("the user's project is not scratch, and neither is a lookalike sibling", () => {
  expect(isScratchPath(join("D:", "Projects", "app", "index.ts"))).toBe(false);
  // `startsWith` on the root string would call this one scratch.
  expect(isScratchPath(`${scratchRoot()}-old/notes.md`)).toBe(false);
  // The root itself is a directory, not a file written inside it.
  expect(isScratchPath(scratchRoot())).toBe(false);
});
