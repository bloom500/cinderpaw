/**
 * Every approval box shows its "yes" option on top and its "no" option below.
 *
 * Cinderpaw draws the options in the order a question lists them. On 16 Oct
 * five questions listed "No"/"Deny" first and the rest "Yes"/"Allow" first, so
 * the same box flipped between chats: a person who learned "Allow is on top"
 * clicked the wrong one. Answers are read by label ("yes", "allow"), never by
 * position, and the safe default is carried by `recommended`, so the order is
 * only what the person sees. This scans the source so a new question cannot
 * bring the flip back.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const REFUSAL = /^(no\b|deny|don't|do not|not now|cancel|skip|refuse)/i;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

test("no question in the agent lists a refusal as its first option", () => {
  const flipped: string[] = [];
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    // The first literal label inside each `options: [` array.
    for (const m of text.matchAll(/options:\s*\[\s*\{\s*label:\s*(["'`])(.*?)\1/g)) {
      if (REFUSAL.test(m[2]!)) flipped.push(`${file.slice(SRC.length + 1)}: "${m[2]}" is first`);
    }
  }
  expect(flipped).toEqual([]);
});

test("the scan does see the questions it guards", () => {
  const text = readFileSync(join(SRC, "tools", "registry.ts"), "utf8");
  expect(/options:\s*\[\s*\{\s*label:\s*"Allow"/.test(text)).toBe(true);
});
