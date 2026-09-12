/**
 * How much of the archived 2700-leaf corpus is the same memory written twice.
 * Diagnostic, not a benchmark: reads the gitignored attribution snapshot and
 * prints what collapseIdentical would do to it, text-only (the snapshot holds
 * no vectors). Run from the worktree root: bun scripts/fms-collapse-count.ts
 */
import { readFileSync } from "node:fs";
import { collapseIdentical } from "../CinderpawAgent/src/memory/fractal/cross-session-dedup.ts";

type Row = { id: number; timestamp: number; content: string };
const rows: Row[] = JSON.parse(readFileSync("data/fms-attribution/corpus.json", "utf8"));
const r = collapseIdentical(rows.map((x) => ({ id: x.id, text: x.content, ts: x.timestamp })));
const sizes = [...r.hitCount.values()].sort((a, b) => b - a);
console.log(`${rows.length} leaves → ${r.survivors.length} survivors`);
console.log(`largest groups: ${sizes.slice(0, 8).join(", ")}`);
const q9 = 1206; // Q9's labelled source in the attribution report
for (const [survivor, members] of r.groups) {
  if (members.includes(q9)) console.log(`Q9 source ${q9} sits in a group of ${members.length} (survivor ${survivor})`);
}
