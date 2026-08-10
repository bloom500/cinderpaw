import { expect, test } from "bun:test";
import { extractPosition } from "../src/core/agent-loop.ts";

test("the position section is lifted out of a summary", () => {
  const summary = [
    "### Established facts",
    "- src/parser.ts created, 120 lines",
    "- `bun test` passes 12/12",
    "",
    "### Position",
    "Parser works for columns 1-2. Column 3 dates still fail.",
    "Next: check the date format before writing the importer.",
  ].join("\n");
  expect(extractPosition(summary)).toBe(
    "Parser works for columns 1-2. Column 3 dates still fail.\n" +
      "Next: check the date format before writing the importer.",
  );
});

test("a summary without a position section yields null, so nothing is overwritten", () => {
  const summary = "### Established facts\n- one fact";
  expect(extractPosition(summary)).toBeNull();
});

test("an empty position section yields null rather than blanking the note", () => {
  const summary = "### Established facts\n- one fact\n\n### Position\n   \n";
  expect(extractPosition(summary)).toBeNull();
});

test("a facts section that follows the position section is not swallowed into it", () => {
  const summary = "### Position\nhalfway\n\n### Established facts\n- a fact";
  expect(extractPosition(summary)).toBe("halfway");
});
