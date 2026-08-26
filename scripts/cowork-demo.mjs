#!/usr/bin/env bun
/**
 * cowork-demo.mjs — seed the local DB with two teammate agents + a first
 * human message, so the Agent Cowork runtime has something reactive to do
 * and the A2A transcript panel comes alive on next app start.
 *
 * Usage (CLOSE THE APP FIRST — one profile holds an exclusive DB writer lock):
 *
 *   bun scripts/cowork-demo.mjs            # auto-detects the DB
 *   bun scripts/cowork-demo.mjs <path.db>  # explicit DB path
 *
 * What it does:
 *   1. Upserts teammates "Atlas" (research/chief-of-staff) and "Bolt" (bugs).
 *   2. Drops a message from "human" into Atlas's inbox asking him to loop
 *      Bolt in — that produces BOTH a Human→Atlas turn AND a real Atlas→Bolt
 *      A2A exchange, i.e. everything the transcript panel can show.
 *   3. Prints what to expect.
 *
 * Idempotent: re-running updates the same agents (fixed ids) and adds one
 * more seed message per run.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const argPath = process.argv[2];

// Same preference order boot.ts uses: cinderpaw.db wins unless only the
// legacy feral.db exists. Candidates cover the places the sidecar's CWD lands
// depending on dev vs packaged runs from this repo.
const candidates = argPath
  ? [argPath]
  : [
      resolve("CinderpawAgent/data/cinderpaw.db"),
      resolve("CinderpawAgent/data/feral.db"),
      resolve("data/cinderpaw.db"),
      resolve("data/feral.db"),
      resolve("target/debug/data/cinderpaw.db"),
      resolve("target/debug/data/feral.db"),
    ];

const dbPath = candidates.find((p) => existsSync(p));
if (!dbPath) {
  console.error(
    `cowork-demo: no database found. Looked in:\n  ${candidates.join("\n  ")}\n` +
      `Pass the DB path explicitly: bun scripts/cowork-demo.mjs <path.db>`,
  );
  process.exit(1);
}

console.log(`cowork-demo: opening ${dbPath}`);

let db;
try {
  db = new Database(dbPath);
  db.exec("BEGIN IMMEDIATE"); // fail fast if the app holds the writer lock
} catch (err) {
  console.error(
    `cowork-demo: cannot open the database (${err.message}).\n` +
      `The desktop app is probably running and holds the exclusive writer lock.\n` +
      `Quit Cinderpaw completely (including the tray icon), then run this again.`,
  );
  process.exit(1);
}

// Ensure the cowork tables exist (no-op when the sidecar already made them).
db.exec(`
  CREATE TABLE IF NOT EXISTS cowork_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    model_pin TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cowork_mailbox (
    id TEXT PRIMARY KEY,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    thread_id TEXT,
    body TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
`);

const upsert = db.query(`
  INSERT INTO cowork_agents (id, name, role, instructions, model_pin, created_at, updated_at)
  VALUES ($id, $name, $role, $instructions, NULL, $now, $now)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role,
    instructions = excluded.instructions, updated_at = excluded.updated_at
`);
const send = db.query(`
  INSERT INTO cowork_mailbox (id, from_agent_id, to_agent_id, thread_id, body, payload_json, status, created_at, read_at)
  VALUES ($id, $from, $to, $thread, $body, NULL, 'pending', $now, NULL)
`);

const now = Date.now();
const ATLAS = "demo-agent-atlas";
const BOLT = "demo-agent-bolt";

upsert.run({
  $id: ATLAS,
  $name: "Atlas",
  $role: "Chief of staff — research & coordination",
  $instructions:
    "You are Atlas, the calm coordinator. Break work down, delegate specialist tasks to your teammate Bolt when they are about fixing or building things, and always summarise outcomes for the human.",
  $now: now,
});
upsert.run({
  $id: BOLT,
  $name: "Bolt",
  $role: "Bug fixes & small builds",
  $instructions:
    "You are Bolt, a hands-on fixer. You get straight to the point, do the concrete work, and report exactly what you did and what you did not manage.",
  $now: now,
});

send.run({
  $id: crypto.randomUUID(),
  $from: "human",
  $to: ATLAS,
  $thread: "demo-thread-1",
  $body:
    "Hi Atlas — say hello to Bolt and agree between the two of you who takes this task: " +
    "draft a short README section introducing the team. Whoever does NOT take it should review it. Keep it to two exchanges each.",
  $now: now,
});

const roster = db.query("SELECT name FROM cowork_agents").all();
const pending = db
  .query("SELECT count(*) AS n FROM cowork_mailbox WHERE status = 'pending'")
  .get();
db.exec("COMMIT");
db.close();

console.log(`cowork-demo: teammates now: ${roster.map((r) => r.name).join(", ")}`);
console.log(`cowork-demo: pending inbox rows: ${pending.n}`);
console.log(
  `
Next steps:
  1. Start the desktop app (or restart it if it was open while seeding).
  2. Open any chat. Within ~15s Atlas picks the message up; his turn runs,
     then he mails Bolt — watch the "Agent Cowork" panel (top-right of the chat).
  3. From chat you can also ask YOUR agent: "check who my teammates are"
     (cowork_team) or "hand X to Bolt" (cowork_send).
`,
);
