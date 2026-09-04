/**
 * Centralized SQLite access.
 *
 * Bun ships SQLite built-in (`bun:sqlite`) with zero external dependencies.
 * All persistent state for Cinderpaw Agent lives in a single database file under
 * `data/`. Schema for every layer is created here so migrations stay in one
 * place and table creation is idempotent.
 */

import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { dirname, sep } from "node:path";

/**
 * How often a live sidecar touches its lockfile to say "still here".
 */
const LOCK_HEARTBEAT_MS = 10_000;

/**
 * A lock whose heartbeat is older than this is treated as abandoned, whatever
 * its pid claims. Generous on purpose: a sidecar paused by a debugger or a long
 * GC must not have its lock stolen out from under it. Six missed beats is not a
 * pause, it is a corpse.
 *
 * This rule deliberately applies to locks written by PRE-heartbeat sidecars too,
 * even though they never touch their lockfile and so always look abandoned. It
 * has to: the installs this fix exists to rescue are exactly the ones holding an
 * old lockfile, and a rule that exempted them would leave them stuck forever —
 * the update would arrive and change nothing.
 *
 * The cost is that a still-running PRE-heartbeat sidecar could have its lock
 * taken. That needs two different Cinderpaw versions writing the same database at
 * once, which the app does not do: the desktop app owns its sidecar's lifetime,
 * and the gateway has a single-instance guard. A permanently dead app is the
 * worse failure, and it is the one that actually happened.
 */
export const LOCK_STALE_AFTER_MS = 60_000;

export interface CinderpawDb {  // exported for test helpers
  raw: Database;
  /** Release the sidecar's writer lock + close the SQLite handle. */
  close(): void;
}

/**
 * Open (creating if needed) the Cinderpaw Agent database and ensure all tables
 * exist. Safe to call once at startup.
 *
 * Sprint 1.9 — single-writer discipline. On non-`:memory:` paths we acquire an
 * exclusive `O_EXCL` lockfile at `~/.cinderpaw/.writer.lock` before opening SQLite.
 * The sidecar is the sole writer of memory state; Tauri commands are readers
 * + ack-only mutators (per `project_memory_roadmap.md`'s writer contract).
 * The lock is released in `close()`. If the lock is already held by another
 * sidecar (config bug), `openDatabase` throws — the second process exits with
 * a clean error rather than corrupting state.
 *
 * The graph layer (`memory/graph.ts`) and the FMS tree have their own
 * `*.lock` files for sub-second cross-process guards; the writer lock here is
 * the *process-level* lock for the SQLite database itself.
 */
/**
 * Could `pid` be OUR sidecar, still running?
 *
 * A `process.kill(pid, 0)` probe answers "does a process with this number
 * exist", which is NOT the question. It used to be treated as if it were, and
 * that bricked the app:
 *
 *   - EPERM was read as "alive, we just can't signal it". But our sidecar is
 *     spawned by the app and runs as the same user, so we can always signal it.
 *     A pid we are *forbidden* to touch is therefore, by construction, not us.
 *     On Windows the recycled pid landed on `svchost` — a SYSTEM process — the
 *     probe returned EPERM, the lock was declared live, and the sidecar refused
 *     to start. Forever. The only cure was deleting a file the user had never
 *     heard of.
 *
 *   - Even fixing that is not enough: pids get recycled, and the next tenant
 *     may well be another process of the user's own (a browser tab, anything).
 *     Then the probe succeeds and the lock looks held by a live process that
 *     has nothing to do with Cinderpaw. A pid is not an identity.
 *
 * So this is only the fast path — it can prove a lock is DEAD, never that it is
 * alive. The heartbeat is what proves liveness; see `isLockAbandoned`.
 */
function couldBeOurSidecar(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH (no such process) and EPERM (not ours to signal) both mean this pid
    // is not a running sidecar of ours.
    return false;
  }
}

/**
 * Has the lock's owner stopped saying it is alive?
 *
 * A running sidecar touches the lockfile every `LOCK_HEARTBEAT_MS`. This is
 * what makes the guard correct under pid recycling: a dead owner cannot keep
 * touching the file, no matter which process inherited its number.
 */
function isLockAbandoned(lockPath: string, now: number): boolean {
  try {
    return now - statSync(lockPath).mtimeMs > LOCK_STALE_AFTER_MS;
  } catch {
    // Gone between the existsSync and here — someone else cleaned it up.
    return true;
  }
}

/**
 * Lock paths this process actually holds right now.
 *
 * Needed to tell two very different situations apart, which otherwise look
 * identical because the lockfile says the same thing in both:
 *
 *   - We opened the database twice in one process. That is a bug, and it must
 *     throw.
 *   - A crashed predecessor left a lock, and the OS handed US its pid. Rare, but
 *     Windows recycles pids freely. Reading that as "we already hold it" would
 *     brick the sidecar exactly like the bug this guard exists to prevent.
 */
const heldLocks = new Set<string>();

export function openDatabase(path: string): CinderpawDb {
  let lockPath: string | null = null;
  let lockFd: number | null = null;

  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    const dir = dirname(path);
    lockPath = `${dir}${sep}.writer.lock`;

    // Stale-lock recovery. A previous sidecar crash left the lockfile
    // on disk; without this check the next boot would refuse to start
    // (EEXIST in the openSync below). Probe the recorded pid: if it's
    // gone (no process with that pid) the lock is garbage and we
    // unlink it before retrying. ES writing this guard tested against
    // mock-dead + mock-live pids in `memory-resilience.test.ts`.
    if (existsSync(lockPath)) {
      const raw = readFileSync(lockPath, "utf8").trim();
      const pid = Number.parseInt(raw, 10);

      // A lock stamped with our own pid that we are NOT holding did not come
      // from us: it came from a dead predecessor whose pid the OS reissued to
      // us. Treat it like any other corpse. Only a lock we genuinely hold means
      // "opened twice", and that must still throw.
      const weHoldIt = heldLocks.has(lockPath);
      const stale =
        !weHoldIt &&
        (!Number.isFinite(pid) || // legacy 0-byte or garbage lockfile
          // Our pid, on a lock we never took: a predecessor's corpse wearing our
          // number. We KNOW we did not write it, so no liveness probe can be
          // more authoritative than that.
          pid === process.pid ||
          !couldBeOurSidecar(pid) || // dead, or a pid we could never own
          // ...and the check that survives pid recycling onto a live stranger:
          // the owner stopped saying it was alive. A dead process cannot keep
          // touching a file, whoever inherited its number.
          isLockAbandoned(lockPath, Date.now()));
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Race: another sidecar cleaned it between our existsSync and
          // unlinkSync. Fall through and let openSync try; if it's
          // still there we'll get EEXIST and the existing error wins.
        }
      }
    }

    try {
      // Stamp our pid so the next sidecar can run the stale check.
      // The fd is closed by `close()` on the returned CinderpawDb; we also
      // re-write on every open because sidecars restart under the
      // same pid (rare but possible after OS pid recycle).
      lockFd = openSync(lockPath, "wx");
      writeSync(lockFd, `${process.pid}\n`);
      heldLocks.add(lockPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Error(
          `cinderpaw: another sidecar already holds the writer lock at ${lockPath} ` +
            `— refusing to open the memory database. ` +
            `If a previous sidecar crashed, remove the lockfile and retry.`,
        );
      }
      throw e;
    }
  }

  // Everything from here to the end of migration can throw. The lock is
  // already held and the database may already be open, and a throw used to
  // leave BOTH behind: the lockfile on disk with nobody heartbeating it, and an
  // open database handle. The next start then found a lock that looked live for
  // the whole staleness window and refused to open the memory at all — a
  // migration bug becoming "Cinderpaw has no memory today".
  const releaseOnFailure = (db: Database | null) => {
    try { db?.close(); } catch { /* best-effort */ }
    if (lockFd !== null) {
      try { closeSync(lockFd); } catch { /* best-effort */ }
    }
    if (lockPath) {
      heldLocks.delete(lockPath);
      try { unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  };

  let db: Database;
  try {
    db = new Database(path, { create: true });
  } catch (err) {
    releaseOnFailure(null);
    throw err;
  }

  try {
    // WAL improves concurrent read/write behavior for the proactive loop (V2)
    // and keeps the audit writer from blocking the agent loop.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    migrate(db);
  } catch (err) {
    releaseOnFailure(db);
    throw err;
  }

  // Say "still here" for as long as we hold the lock. This is the only claim of
  // liveness anyone can trust: a crashed sidecar stops touching the file, so its
  // lock ages out and the next start reclaims it — no manual cleanup, and no
  // dependence on a pid that the OS may have handed to somebody else.
  // `unref()` so a live heartbeat can never hold the process open at shutdown.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (lockPath !== null) {
    const beat = lockPath;
    heartbeat = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(beat, now, now);
      } catch {
        // The lockfile was removed out from under us. Nothing useful to do —
        // close() will handle the rest, and a missed beat is not fatal.
      }
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  return {
    raw: db,
    close: () => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      db.close();
      if (lockFd !== null) {
        try { closeSync(lockFd); } catch { /* best-effort */ }
        if (lockPath) {
          heldLocks.delete(lockPath);
          try { unlinkSync(lockPath); } catch { /* best-effort */ }
        }
      }
    },
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

/**
 * Sprint 1 — current memory schema version. Bump this in code whenever a
 * migration in `migrate()` is more than an idempotent `addColumnIfMissing`
 * (i.e. anything that changes a column type, drops a table, or alters the
 * shape of a persisted JSON payload). The sidecar refuses to start when the
 * on-disk `schema_version` exceeds this value (forward-compat protection —
 * rolling back an install on top of a newer schema is the dangerous case).
 *
 *   v0 → 1: meta table created (current_task + embedding_model + schema_version)
 *   v1 → 2: workspaces table + workspace_id column on episodic / semantic
 */
export const CURRENT_MEMORY_SCHEMA_VERSION = 2;

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

  // Sprint 1.4 — workspace scoping. `workspace_id` is the UUID assigned by
  // `memory/workspaces.ts::createWorkspace`. Nullable because global facts
  // (user identity, language preferences) live in `semantic` without a
  // workspace; episodic is required to have one for every row written by the
  // agent after this migration ships.
  addColumnIfMissing(db, "episodic", "workspace_id", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_episodic_workspace
      ON episodic (workspace_id, timestamp);
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

  // One row per completion, written at the router's single choke point.
  //
  // `token_usage` above answers "how much today", which is a budget question.
  // This answers "where does it go", which is a design question, and no
  // aggregate can be disaggregated back into it. Instrumented at the source for
  // the reason the last cost estimate got it wrong: a number deduced from the
  // difference between two measurements is a number about something else.
  //
  // The three cache columns are NULL — not 0 — when the provider says nothing.
  // Zero means "nothing was cached", which is a finding; NULL means "we do not
  // know", which is a different one, and collapsing them would make a cache
  // that silently stopped working look like a cache that is working and empty.
  //
  // `fresh_tokens` is stored rather than derived because the two provider
  // dialects disagree about whether `prompt_tokens` includes the cached ones.
  // See `InferenceResponse.freshPromptTokens`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS completion_cost (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      fresh_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      latency_ms INTEGER NOT NULL,
      used_fallback INTEGER NOT NULL,
      -- The other account of the same completion: what WE sent, by category,
      -- measured with our own tokenizer. Same row as the provider's numbers so
      -- the two are never joined by guessing at a timestamp — and never mixed:
      -- local_prompt_tokens is ours and approximate, prompt_tokens above is
      -- theirs and authoritative. The gap between them is a fact to look at,
      -- not one to normalize away.
      breakdown_json TEXT,
      local_prompt_tokens INTEGER,
      -- 1 when the provider reported no usage and the token columns above are
      -- OUR estimate of our own messages. Without it an estimate is
      -- indistinguishable from an authority, which is exactly how one came to
      -- be recorded as "what the provider charged" on every streamed
      -- completion.
      tokens_estimated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS completion_cost_session ON completion_cost(session_id, ts);
  `);
  // The column above only lands on a database that has never seen this table:
  // `CREATE TABLE IF NOT EXISTS` is a no-op once it exists, so a field added
  // later needs the ALTER path or every INSERT naming it fails — silently, in
  // this case, because the writer swallows its own errors by design.
  addColumnIfMissing(db, "completion_cost", "tokens_estimated", "INTEGER NOT NULL DEFAULT 0");

  // Semantic memory: persistent key-value facts about the user, updated by the
  // agent as it learns preferences, context, and long-term patterns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- The agent's durable task list (todo_write / TodoStore). Survives
    -- compaction and session boundaries, which is the point: the transcript
    -- that recorded the work is summarized away, these rows are not.
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- An unattended RUN and its per-turn record. The checkpoint below does this
    -- for one turn; these two tables do it for a whole run, which is the part
    -- that was missing: runUnattended held the mission, deadline and budgets in
    -- a local variable, so a sidecar restart at hour 4 left nothing to resume
    -- from and nothing to explain the silence.
    --
    -- Same signal as the checkpoint: a row still marked 'running' after a
    -- restart IS the crash. A killed process writes nothing, which is the one
    -- thing it does reliably, so no crash handler is needed to produce it.
    --
    -- The transcript is deliberately NOT duplicated here — it lives in the
    -- session tables, and two copies is how they come to disagree.
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      mission TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      -- ABSOLUTE epoch ms. A relative deadline would restart on every resume
      -- and make an 8h run immortal.
      deadline_at INTEGER,
      continuations_used INTEGER NOT NULL DEFAULT 0,
      -- Snapshotted at start, so changing the env var mid-run cannot move the
      -- goalposts of a run already in flight.
      continuation_budget INTEGER NOT NULL,
      replan_used INTEGER NOT NULL DEFAULT 0,
      -- These three rebuild a SafetyPoint after a restart: changedSince() takes
      -- the object, not a ref, so the fields have to survive on their own.
      safety_root TEXT,
      safety_before TEXT,
      safety_git_dir TEXT,
      done_when TEXT,
      delivery TEXT,
      status TEXT NOT NULL,
      stopped_because TEXT,
      resumes INTEGER NOT NULL DEFAULT 0,
      last_resume_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS runs_status ON runs(status);

    CREATE TABLE IF NOT EXISTS run_turns (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      tool_calls INTEGER NOT NULL,
      continuation INTEGER NOT NULL,
      replan INTEGER NOT NULL,
      -- One total, not prompt/completion: the only seam available is the
      -- router's per-conversation counter, whose delta cannot be split.
      tokens INTEGER NOT NULL,
      -- Artifact evidence. A turn with zeroes in both made no progress,
      -- whatever its outcome claims.
      files_changed INTEGER NOT NULL,
      todos_closed INTEGER NOT NULL,
      -- NULL = not evaluated this turn. 0 would read as "the check failed".
      done_when_pass INTEGER,
      PRIMARY KEY (run_id, seq)
    );

    -- Mid-turn checkpoint (CheckpointStore). One row per session holds the
    -- full working-memory transcript so a crash at iteration 7 of 15 resumes
    -- with every completed step intact, instead of replaying the lossy
    -- 400-char episodic copy. status 'running' = a turn in flight; a row that
    -- outlives the process is a crash to resume from.
    CREATE TABLE IF NOT EXISTS session_checkpoint (
      session_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      messages TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // The report a finished run owes its person, and whether it was handed over.
  //
  // Without these, a run that finished and died before the message left the
  // process was unrecoverable BY CONSTRUCTION: the crash signal is
  // `status = 'running'` (see run-resume.ts), so the moment `finish()` ran the
  // row stopped being something any later boot would look at — and the report
  // itself only ever existed in RAM. Written in the SAME statement as the
  // terminal status, so there is no instant where a row claims to be done and
  // cannot say what it concluded.
  //
  // `delivered_at IS NULL` with a report present is the one state that means
  // "somebody is still owed this".
  addColumnIfMissing(db, "runs", "report", "TEXT");
  addColumnIfMissing(db, "runs", "delivered_at", "INTEGER");
  // Refusals BY THE TARGET, not failed attempts: a boot where the connector was
  // not up yet never asked anyone anything and must not count against the
  // report. See `ChannelAskRouter.notify` and `run-delivery.ts`.
  addColumnIfMissing(db, "runs", "delivery_attempts", "INTEGER NOT NULL DEFAULT 0");

  // Sprint 1.4 — same workspace scoping as episodic. `semantic` rows MAY be
  // global (`workspace_id IS NULL`) — user identity, language, communication
  // style — to survive workspace switches.
  addColumnIfMissing(db, "semantic", "workspace_id", "TEXT");

  // Non-owner rows: a turn written by a session under a RESTRICTED profile
  // (the public WhatsApp lead mode — a stranger, not the user). Excluded from
  // the CROSS-session searches, `search()` and `all()`, so a lead's transcript
  // never surfaces in the owner's `recall` and never enters the fractal tree.
  // Session-scoped reads ignore the flag, so the lead keeps their own thread.
  // Default 0 = every pre-existing row is the owner's, which it was.
  addColumnIfMissing(db, "episodic", "private", "INTEGER NOT NULL DEFAULT 0");

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
  // A job's optional mechanical completion assertion (cron/done-when.ts).
  // Stored as JSON so the check can gain shapes without another migration.
  addColumnIfMissing(db, "cron_jobs", "done_when_json", "TEXT");
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
  // bun:sqlite and the Cinderpaw DB. Writes are mediated by the Rust
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

  // ── Memory meta (Sprint 1.2 — Memory Foundation) ────────────────────────────
  //
  // App-wide key-value meta: current task (Resume), embedding-model identity,
  // last FMS rebuild timestamp, schema version. Distinct from `rsi_meta`
  // (RSI-internal). The `key` is TEXT PK so the table is a stable contract
  // for both read paths (the sidecar reading current_task on startup, the
  // Tauri command `get_last_task` reading the same row). `value` is TEXT
  // — JSON-encoded for structured payloads (current_task is `{title, ts,
  // workspace_id}`, embedding_model is `{name, dim, last_built_at, sha}`).
  //
  // Reserved keys (see `docs/agents-memory/project_memory_roadmap.md`):
  //   - "current_task"        → Memory Resume payload
  //   - "embedding_model"     → {name, dim, last_built_at, sha}
  //   - "schema_version"      → INTEGER-as-string; incremented on every
  //                              migration. Sidecar refuses to start when
  //                              this exceeds its expected version.
  //   - "active_workspace_id" → UUID of the workspace the user last opened.
  //                              Drives the WelcomeBack banner + the
  //                              RecallEngine default workspace filter.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // ── Workspaces (Sprint 1.3 — Memory Foundation) ─────────────────────────────
  //
  // Stable identity per workspace. UUID on create, name is a display label
  // only — two projects called "Agent" must not collide on
  // `WHERE name = ?`. `root_path` is the directory the workspace was opened
  // from; nullable for "scratch" workspaces the user opens without a path.
  // `created_at` / `last_active_at` drive the "Recent workspaces" list and
  // the WelcomeBack banner copy ("Welcome back to Cinderpaw — you were working
  // in <workspace name>").
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workspaces_last_active
      ON workspaces (last_active_at DESC);
  `);

  // ── Cowork agents (Agent Cowork S1) ─────────────────────────────────────────
  //
  // One row per persistent named cowork agent (Grok Bot-style "Bots").
  // Pure identity + configuration: name, role, standing instructions,
  // optional Brain-model pin (`null` ⇒ the Brain Stack routes per task).
  // Runtime state (mailboxes, handoffs, threads) gets its own tables in
  // later slices (S2+) — they were deliberately NOT crammed in here.
  // Written only by the sidecar, per the writer contract.
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
  `);
  // `tools`: JSON array of tool names this teammate may call, or NULL for
  // "whatever the host allows". Added after the first real run showed why it
  // matters: every teammate was handed the entire registry, so each of its
  // completions re-sent ~16.5k tokens of tool schema to produce ~600 tokens of
  // answer, and the wait to the first token ran 13-55 seconds. A coordinator
  // needs a handful of tools, not thirty-nine.
  addColumnIfMissing(db, "cowork_agents", "tools", "TEXT");

  // cowork_mailbox (S2) — A2A asynchronous messages. One row per message;
  // `from_agent_id` / `to_agent_id` hold agent ids or the literal "human".
  // `payload_json` is optional structured content (pointers, not blobs).
  db.exec(`
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cowork_mailbox_inbox
      ON cowork_mailbox (to_agent_id, status, created_at DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cowork_mailbox_outbox
      ON cowork_mailbox (from_agent_id, created_at DESC);
  `);

  // cowork_handoffs (S2) — structured task ownership transfers. TeamOlimpo
  // rule: a handoff with no terminal status means the task is NOT done, so
  // every row must be drivable to completed|failed; the handoff service
  // enforces the transitions. `artifact_refs_json` is a JSON array of
  // pointers into memory/workspace.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_handoffs (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'initiated',
      summary TEXT NOT NULL,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      result_summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cowork_handoffs_to
      ON cowork_handoffs (to_agent_id, status);
  `);

  // cowork_approvals (S4) — deterministic approval gate for consequential
  // actions a cowork agent is about to take (send/publish/delete/purchase/
  // prod_change). One row per gate hit; status lifecycle pending →
  // approved|denied|expired is enforced by the repo (terminal states are
  // never rewritten) and every row is the durable audit trail of a decision.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      approval_class TEXT NOT NULL,
      description TEXT NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cowork_approvals_pending
      ON cowork_approvals (status, created_at DESC);
  `);

  // Stamp the schema version after every successful migration. Done last so
  // a partial migration (one that throws halfway) leaves `schema_version`
  // pointing at the previous value — the next startup retries from there.
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const onDisk = row ? Number(row.value) : 0;
  if (!Number.isFinite(onDisk) || onDisk < CURRENT_MEMORY_SCHEMA_VERSION) {
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, ?)",
    ).run("schema_version", String(CURRENT_MEMORY_SCHEMA_VERSION), Date.now());
  } else if (onDisk > CURRENT_MEMORY_SCHEMA_VERSION) {
    // Forward-compat guard. The on-disk DB was written by a newer sidecar;
    // we will corrupt memory if we keep opening it. Surface a clear error
    // instead of a cryptic SQLite fault.
    throw new Error(
      `cinderpaw: on-disk memory schema version (${onDisk}) is newer than this ` +
        `build supports (${CURRENT_MEMORY_SCHEMA_VERSION}). ` +
        `Refusing to start — please upgrade Cinderpaw.`,
    );
  }
}