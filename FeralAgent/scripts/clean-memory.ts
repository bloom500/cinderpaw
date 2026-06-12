/**
 * One-off memory hygiene pass (run manually):
 *   bun run scripts/clean-memory.ts          # dry run — prints what would go
 *   bun run scripts/clean-memory.ts --apply  # actually delete
 *
 * Removes from semantic memory + memory-graph.json:
 *   - anything mentioning "fable" (key, value, label) — user asked repeatedly
 *   - junk keys produced by the old colon-split extractor: list-marker
 *     prefixes ("- ", "1. "), sentence-shaped keys, reasoning leakage,
 *     drive-letter splits (value starts with "\"), role names.
 */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const APPLY = process.argv.includes("--apply");

const ROLE_KEYS = new Set([
  "user", "assistant", "model", "bot", "system", "nick", "observation",
  "facts", "type", "title", "concepts", "none", "skip",
]);

function isJunkKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (ROLE_KEYS.has(k)) return true;
  if (/^[-*•]/.test(k)) return true;          // list marker leaked into key
  if (/^\d+[.)]/.test(k)) return true;         // numbered line leaked
  if (k.split(/\s+/).length > 4) return true;  // sentence, not a key
  if (k.length > 40) return true;
  if (/["'<>{}]/.test(k)) return true;         // quotes/JSON fragments
  return false;
}

function mentionsFable(...parts: (string | undefined)[]): boolean {
  return parts.some((p) => p && p.toLowerCase().includes("fable"));
}

// ── 1. semantic table ──────────────────────────────────────────────────
const db = new Database(join(homedir(), ".feral", "agent", "feral.db"));
const rows = db.query("SELECT key, value FROM semantic").all() as {
  key: string;
  value: string;
}[];

const doomed = rows.filter(
  (r) =>
    isJunkKey(r.key) ||
    mentionsFable(r.key, r.value) ||
    r.value.trimStart().startsWith("\\"), // drive-letter colon split
);

console.log(`semantic: ${rows.length} rows, removing ${doomed.length}:`);
for (const r of doomed) console.log(`  DEL ${JSON.stringify(r.key)}`);

if (APPLY) {
  const del = db.prepare("DELETE FROM semantic WHERE key = ?");
  for (const r of doomed) del.run(r.key);
}

// ── 2. memory-graph.json ───────────────────────────────────────────────
const graphPath = join(homedir(), ".feral", "memory-graph.json");
if (existsSync(graphPath)) {
  type Node = { id?: string; label?: string; value?: string; [k: string]: unknown };
  const graph = JSON.parse(readFileSync(graphPath, "utf8")) as {
    nodes: Record<string, Node>;
    edges: { from: string; to: string; [k: string]: unknown }[];
  };

  const nodeIds = Object.keys(graph.nodes);
  const doomedIds = nodeIds.filter((id) => {
    const n = graph.nodes[id]!;
    return (
      isJunkKey(id.replace(/_/g, " ")) ||
      mentionsFable(id, n.label as string | undefined, n.value as string | undefined, JSON.stringify(n))
    );
  });

  console.log(`\ngraph: ${nodeIds.length} nodes, removing ${doomedIds.length}:`);
  for (const id of doomedIds) console.log(`  DEL ${JSON.stringify(id)}`);

  if (APPLY) {
    const gone = new Set(doomedIds);
    for (const id of doomedIds) delete graph.nodes[id];
    const beforeEdges = graph.edges.length;
    graph.edges = graph.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));
    console.log(`  (+ ${beforeEdges - graph.edges.length} orphaned edges)`);
  }
}

console.log(APPLY ? "\nAPPLIED." : "\nDRY RUN — re-run with --apply to delete.");
