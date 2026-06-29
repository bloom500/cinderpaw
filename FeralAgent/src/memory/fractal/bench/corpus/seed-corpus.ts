/**
 * Seed the synthetic benchmark corpus into a fresh episodic DB.
 *
 * The FMS gate reads memories from the live episodic DB and FTS5 retrieval is
 * half the comparison, so memories MUST go in through `EpisodicMemory.record`
 * (which fires the episodic_fts triggers) — never a raw INSERT that would leave
 * the FTS index empty and silently zero out the FTS5 arm of the benchmark.
 *
 * Insert order == file order, and a fresh DB autoincrements 1..N, so the row
 * ids line up with the `relevant` ids baked into queries.jsonl. The seeder
 * asserts that alignment and refuses to run against a non-empty DB (which would
 * shift every id and invalidate the gold labels).
 *
 * Run:  FERAL_DB=data/bench-corpus.db bun run src/memory/fractal/bench/corpus/seed-corpus.ts
 */
import { openDatabase } from "../../../../db.ts";
import { EpisodicMemory } from "../../../episodic.ts";

const dbPath = process.env.FERAL_DB ?? "data/bench-corpus.db";
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const memories = fs
  .readFileSync(path.join(here, "memories.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { id: number; text: string });

const db = openDatabase(dbPath);
const existing = db.raw.query<{ c: number }, []>("SELECT count(*) AS c FROM episodic").get()?.c ?? 0;
if (existing > 0) {
  throw new Error(
    `seed-corpus: ${dbPath} already has ${existing} episodic rows — seed into a FRESH DB ` +
      `(delete it first) so row ids stay aligned with queries.jsonl`,
  );
}

const episodic = new EpisodicMemory(db.raw, () => {});
let n = 0;
for (const m of memories) {
  const id = episodic.record("bench", "user", m.text);
  if (id !== m.id) {
    throw new Error(`seed-corpus: id drift — file id ${m.id} got row id ${id}; aborting`);
  }
  n++;
}

console.log(`seed-corpus: inserted ${n} memories into ${dbPath} (ids 1..${n} aligned with gold)`);
