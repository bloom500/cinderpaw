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

  // Fractal Memory Search (Phase 0): per-row embedding vector, stored as a
  // Float32 little-endian BLOB. Added idempotently so existing databases
  // upgrade in place. NULL means "not embedded yet" — the row falls back to
  // FTS5 (the exact-match leaf layer) until a recall/cluster pass or the
  // one-shot backfill populates it.
  addColumnIfMissing(db, "episodic", "embedding", "BLOB");

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

  // ── RSI (Fractal Memory System) ────────────────────────────────────────────
  //
  // Five tables for the RSI substrate. The Rust boundary
  // (src-tauri/src/rsi/) defines the types and the safety rules;
  // the sidecar owns these rows because the sidecar already owns
  // bun:sqlite and the Feral DB. Writes are mediated by the Rust
  // commands — the sidecar never inserts or updates these tables
  // directly without a Tauri command on the path. The Rust shapes
  // are the authoritative wire format; if you change a column
  // shape here, change the matching struct in
  // src-tauri/src/rsi/types.rs in the same commit.

  // rsi_genome — the unit of evolution. One row per candidate that
  // was ever committed to the RSI git substrate. `alive` is the
  // selection cull flag (Faza 2); Hall of Fame entries keep it true
  // forever. `behavioral_fp` is stored as a packed float32 blob; the
  // sidecar packs/unpacks it on read/write.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rsi_genome (
      id TEXT PRIMARY KEY,
      commit_hash TEXT NOT NULL,
      parent_ids TEXT NOT NULL DEFAULT '[]',
      strategy_dna TEXT NOT NULL,
      fitness_score REAL,
      behavioral_fp BLOB,
      shared_fitness REAL,
      generation INTEGER NOT NULL,
      alive INTEGER NOT NULL DEFAULT 1,
      explanation TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rsi_genome_generation
      ON rsi_genome (generation);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rsi_genome_alive
      ON rsi_genome (alive);
  `);

  // rsi_iteration — one row per (genome, evaluation pass). The eval
  // results JSON is the sidecar's structured record of what happened;
  // Rust reads the Tier 1 / Tier 2 aggregate scores off this row for
  // the Goodhart detector. `noise_k` is the number of eval runs that
  // were aggregated before this row was written (≥ 2 by default so
  // the ratchet has a noise estimate). `improvement_difficulty` is
  // added in Faza 1 (Recalcitrance) — null until the Faza 1
  // migration runs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rsi_iteration (
      id TEXT PRIMARY KEY,
      genome_id TEXT NOT NULL,
      eval_results TEXT NOT NULL,
      token_cost INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      ratchet_event INTEGER NOT NULL DEFAULT 0,
      pbt_sync INTEGER NOT NULL DEFAULT 0,
      goodhart_flag INTEGER NOT NULL DEFAULT 0,
      noise_k INTEGER NOT NULL DEFAULT 2,
      created_at INTEGER NOT NULL
    );
  `);
  // Faza 1 migration: improve­ment_difficulty (Recalcitrance).
  // Idempotent ALTER so existing rows upgrade in place.
  addColumnIfMissing(db, "rsi_iteration", "improvement_difficulty", "REAL");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rsi_iteration_genome
      ON rsi_iteration (genome_id, created_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rsi_iteration_ratchet
      ON rsi_iteration (ratchet_event, created_at);
  `);

  // rsi_lineage — directed parent → child edge. Composite PK so the
  // same child can have multiple parents (crossover). `crossover_type`
  // is one of `mutation|crossover|parametric|wild`; `lca_commit` is
  // set only for `crossover` and carries the git LCA between the two
  // parents (free from the commit DAG).
  db.exec(`
    CREATE TABLE IF NOT EXISTS rsi_lineage (
      child_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      crossover_type TEXT NOT NULL,
      lca_commit TEXT,
      PRIMARY KEY (child_id, parent_id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rsi_lineage_parent
      ON rsi_lineage (parent_id);
  `);

  // rsi_hall_of_fame — genomes that are immune to extinction. Two
  // automatic induction paths (best-all-time + Tier 2 breakthrough)
  // plus a manual entry point. `reason` is one of
  // `all_time_best|tier2_breakthrough|manual`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rsi_hall_of_fame (
      genome_id TEXT NOT NULL,
      inducted_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (genome_id, reason)
    );
  `);

  // rsi_strategy_genome — hyperparameter vector controlling HOW the
  // Level-1 search operates. Meta-RSI (Faza 3.5, Opus-owned) mutates
  // these; until then the four seeds inserted at Faza 0 bootstrap
  // are the only rows. `hyperparams` carries at minimum
  // `mutation_rate`, `population_size`, `zoom_policy`, and
  // `selection_pressure`. `ratchet_count` is how many ratchet
  // events this strategy-genome has been in charge for — used by
  // PBT to identify bottom-20% candidates.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rsi_strategy_genome (
      id TEXT PRIMARY KEY,
      hyperparams TEXT NOT NULL,
      ratchet_count INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      last_sync_at INTEGER
    );
  `);
}
