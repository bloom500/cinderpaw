#!/usr/bin/env bun
/**
 * check-doc-links.ts — every relative link in a Markdown file must point at a
 * file that is actually in the repository.
 *
 * Why: `PROMISES.md` was linked from the Discord onboarding and returned 404 on
 * GitHub, because nothing here ever created it. The same shape had already
 * shipped inside ARCHITECTURE.md, whose four "docs/…" links pointed one folder
 * too high. A dead link costs nothing to make and is invisible to whoever wrote
 * it: the author has the file open locally, and the stranger has a 404.
 *
 * Tracked, not merely present: a link to a file that exists on this disk but was
 * never committed is a 404 for everybody else. `git ls-files` is the truth.
 *
 * Skipped: fenced code blocks (illustrations, not links), external URLs,
 * anchors, and mailto. Anchors inside a target (`file.md#section`) are trimmed;
 * this checks the file, not the heading.
 *
 * Usage: bun run scripts/check-doc-links.ts
 * Exit:  0 all links resolve, 1 at least one is dead, 2 script error.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, normalize, posix } from "node:path";

const tracked = new Set(
  execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean),
);
const trackedDirs = new Set<string>();
for (const f of tracked) {
  let d = posix.dirname(f);
  while (d && d !== ".") {
    trackedDirs.add(d);
    d = posix.dirname(d);
  }
}

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** README opens with an HTML banner, not Markdown. A missing image there is the
 *  first thing a stranger sees, so the raw tags are checked too. */
const HTML_ASSET = /<(?:img|a|source)[^>]*?(?:src|href)="([^"]+)"/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Fenced blocks are examples of Markdown, not Markdown. Dropping them is the
 *  difference between six false alarms and none in this repo. */
function withoutCodeBlocks(md: string): string {
  return md
    .split("\n")
    .reduce<{ out: string[]; fence: string | null }>(
      (acc, line) => {
        const fence = line.match(/^\s*(```+|~~~+)/)?.[1];
        if (fence && acc.fence === null) return { out: acc.out, fence };
        if (fence && line.trimStart().startsWith(acc.fence!)) return { out: acc.out, fence: null };
        if (acc.fence === null) acc.out.push(line.replace(/`[^`]*`/g, ""));
        return acc;
      },
      { out: [], fence: null },
    )
    .out.join("\n");
}

const dead: { file: string; target: string }[] = [];
for (const file of tracked) {
  if (!file.endsWith(".md")) continue;
  const body = withoutCodeBlocks(readFileSync(file, "utf8"));
  for (const m of [...body.matchAll(LINK), ...body.matchAll(HTML_ASSET)]) {
    const raw = m[1]!;
    if (EXTERNAL.test(raw)) continue;
    const target = decodeURI(raw.split("#")[0]!);
    if (!target) continue;
    const resolved = normalize(posix.join(dirname(file), target)).split("\\").join("/");
    const path = resolved.replace(/\/$/, "");
    if (!tracked.has(path) && !trackedDirs.has(path)) dead.push({ file, target: raw });
  }
}

if (dead.length === 0) {
  console.log(`✅ every relative Markdown link resolves (${tracked.size} tracked files scanned)`);
  process.exit(0);
}
console.error(`❌ ${dead.length} dead Markdown link(s) — each one is a 404 on GitHub:\n`);
for (const d of dead) console.error(`  ${d.file} → ${d.target}`);
console.error("\nEither create the file and commit it, or fix the path.");
process.exit(1);
