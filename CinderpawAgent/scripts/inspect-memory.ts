// One-off inspection: dump tables and any memory rows mentioning "fable"
// or junk keys (leading "- ", etc). Read-only.
import { Database } from "bun:sqlite";

const db = new Database(`${process.env.USERPROFILE}/.feral/agent/feral.db`, {
  readonly: true,
});

const tables = db
  .query(`SELECT name FROM sqlite_master WHERE type='table'`)
  .all() as { name: string }[];
console.log("tables:", tables.map((t) => t.name).join(", "));

for (const { name } of tables) {
  const cols = db.query(`PRAGMA table_info(${name})`).all() as { name: string }[];
  console.log(`\n== ${name} (${cols.map((c) => c.name).join(", ")})`);
  const count = db.query(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number };
  console.log(`   rows: ${count.n}`);
}
