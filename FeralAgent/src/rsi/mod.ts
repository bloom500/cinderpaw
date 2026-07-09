/**
 * Feral Agent — RSI (Recursive Self-Improvement) sidecar module.
 *
 * The Rust crate under `src-tauri/src/rsi/` is the Bounded-RSI
 * boundary. This module is the thin sidecar wrapper that:
 *
 *   1. Bootstraps the *sidecar-owned* slice of the substrate — the
 *      5 tables in the Feral Agent's SQLite DB, plus the 4 initial
 *      strategy-genomes. The Rust side bootstraps its own slice
 *      (the git repo + PLAN.md + SandboxBounds) at Tauri app
 *      startup, independently, in `src-tauri/src/lib.rs::setup`.
 *   2. Persists iteration rows in the sidecar's SQLite DB after
 *      Rust has approved the corresponding git write (Faza 1+).
 *
 * Communication topology: the sidecar talks to Rust via stdin
 * (Rust → sidecar commands) and stdout (sidecar → Tauri events).
 * The bootstrap here does NOT call `rsi_init` over a bridge — the Rust
 * crate runs its own bootstrap in `setup()`, before the sidecar starts
 * handling messages, so by the time `bootstrapOnce` runs the Rust slice
 * already exists.
 *
 * NOTE (Faza 1, 7b-part2): sidecar → Rust request/response over the
 * stdin/stdout pipe IS now supported — `RsiBridge` (bridge.ts) +
 * `handle_rsi_request` (Rust dispatcher) implement protocol (a), with an
 * ack-with-timeout to handle the sidecar-not-ready race. The engine uses
 * it for `rsi_commit_genome`, `rsi_ratchet_attempt`, and `rsi_score`
 * (see adapters.ts). The React UI still calls the same Rust commands
 * directly via its tauri invoke layer for the /rsi page; both callers
 * coexist.
 */

import type { Database } from "bun:sqlite";
import { seedStrategyGenomes } from "./l1-config/strategy-seeds.ts";

// ── Re-exports ──────────────────────────────────────────────────────────────

export { STRATEGY_SEED_VERSION, seedStrategyGenomes } from "./l1-config/strategy-seeds.ts";
export type { StrategyGenomeSeed } from "./l1-config/strategy-seeds.ts";

// ── One-time bootstrap (sidecar-owned slice only) ──────────────────────────

/**
 * Boot the *sidecar-owned* slice of the RSI substrate for this
 * sidecar session. Idempotent: `seedStrategyGenomes` uses
 * `INSERT OR IGNORE` so re-running on an already-seeded DB is a
 * no-op.
 *
 * The Rust-owned slice (git repo, PLAN.md, SandboxBounds, audit
 * chain) is bootstrapped separately by the Tauri app's `setup`
 * hook. By the time this function is called, the Rust slice has
 * already been initialised — the order of operations at startup
 * is: Tauri `setup()` → Rust `rsi::bootstrap()` → sidecar spawn →
 * sidecar `bootstrapOnce(db)`.
 *
 * Returns the number of strategy-genomes that were actually
 * inserted on this run (0 if the DB was already seeded).
 */
export interface BootstrapResult {
  /** Strategy-genomes inserted on this run. 0 if the DB was seeded. */
  strategyGenomesSeeded: number;
  /** True iff every expected RSI table is present. */
  allTablesPresent: boolean;
  /** Missing table names — empty when allTablesPresent. */
  missingTables: string[];
}

export function bootstrapOnce(db: Database): BootstrapResult {
  const missing = checkRsiTables(db);
  const seeded = seedStrategyGenomes(db);
  return {
    strategyGenomesSeeded: seeded,
    allTablesPresent: missing.length === 0,
    missingTables: missing,
  };
}

/**
 * Table existence check for the 5 RSI tables. Returns the missing
 * table names; empty list means everything is in place. Used by
 * the bootstrap path to diagnose partial migrations.
 */
export function checkRsiTables(db: Database): string[] {
  const expected = [
    "rsi_genome",
    "rsi_iteration",
    "rsi_lineage",
    "rsi_hall_of_fame",
    "rsi_strategy_genome",
  ];
  const present = new Set(
    (db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as { name: string }[]).map((r) => r.name),
  );
  return expected.filter((t) => !present.has(t));
}
