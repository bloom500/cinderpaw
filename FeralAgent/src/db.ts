/**
 * Centralized SQLite access.
 *
 * Bun ships SQLite built-in (`bun:sqlite`) with zero external dependencies.
 * All persistent state for Feral Agent lives in a single database file under
 * `data/`. Schema for every layer is created here so migrations stay in one
 * place and table creation is idempotent.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface FeralDb {  // exported for test helpers
  raw: Database;
  close(): void;
}

/**
 * Open (creating if needed) the Feral Agent database and ensure all tables
 * exist. Safe to call once at startup.
 */
export function openDatabase(path: string): FeralDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true });

  // WAL improves concurrent read/write behavior for the proactive loop (V2)
  // and keeps the audit writer from blocking the agent loop.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  migrate(db);

  return {
    raw: db,
    close: () => db.close(),
  };
}

/**
 * Add a column to a table only if it isn't already present, so migrations
 * stay idempotent across restarts and in-place upgrades. Table/column names
 * are compile-time literals here — never interpolate user input.
 */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      tool_name TEXT,
      args_json TEXT,
      result TEXT NOT NULL,
      blocked_reason TEXT,
      token_cost INTEGER,
      duration_ms INTEGER
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_session
      ON audit_log (session_id, timestamp);
  `);

  // Tamper-evidence (H-2): hash-chain columns. Added via idempotent ALTER so
  // existing databases upgrade in place without losing rows. `prev_hash` links
  // each entry to the previous one's `entry_hash`; together they make any
  // post-hoc UPDATE/DELETE on the audit_log detectable (see AuditLog.verify).
  addColumnIfMissing(db, "audit_log", "prev_hash", "TEXT");
  addColumnIfMissing(db, "audit_log", "entry_hash", "TEXT");

  // Episodic memory: the searchable record of everything said and done.
  // Backed by an FTS5 virtual table for fast full-text recall.
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_episodic_session
      ON episodic (session_id, timestamp);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
      content,
      content='episodic',
      content_rowid='id'
    );
  `);

  // Keep the FTS index synchronized with the base table via triggers.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodic_ai AFTER INSERT ON episodic BEGIN
      INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodic_ad AFTER DELETE ON episodic BEGIN
      INSERT INTO episodic_fts(episodic_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodic_au AFTER UPDATE ON episodic BEGIN
      INSERT INTO episodic_fts(episodic_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  // Daily token accounting for the inference router's budget enforcement.
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      day TEXT PRIMARY KEY,
      tokens INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Semantic memory: persistent key-value facts about the user, updated by the
  // agent as it learns preferences, context, and long-term patterns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Inner-thoughts log: record of every proactive thought the agent generated,
  // whether it was surfaced to the user or suppressed by mood/threshold.
  db.exec(`
    CREATE TABLE IF NOT EXISTS inner_thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      thought TEXT NOT NULL,
      surfaced INTEGER NOT NULL DEFAULT 0,
      mood_snapshot TEXT
    );
  `);

  // Cron jobs (P0-3). One row per user-schedulable job. Schedule + delivery
  // are JSON-serialised blobs so the schedule/delivery unions can evolve
  // without an ALTER TABLE.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      task TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      delivery_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_ms INTEGER,
      next_run_ms INTEGER,
      history_json TEXT NOT NULL DEFAULT '[]',
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
      ON cron_jobs (enabled, next_run_ms);
  `);

  // Skill log (P0-2). Append-only record of skill create/refine events.
  // Drives the "self-improving" loop and gives the user a single place
  // to see why a skill was created or refined.
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      skill_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      version INTEGER
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skill_log_skill
      ON skill_log (skill_id, timestamp);
  `);
}
