/**
 * The four initial strategy-genomes that seed the meta-RSI
 * population at Faza 0 bootstrap.
 *
 * Each seed is a hyperparameter profile chosen to maximise
 * exploration of the strategy space — they are intentionally
 * spread across the corners of a sensible region so PBT (Faza 3.5,
 * Opus-owned) has something heterogeneous to mix-and-match. They
 * are NOT tuned for any specific outcome; tuning is what the RSI
 * loop does once it's running.
 *
 * `zoom_policy` is the JSON shape that Fractal Search (Faza 3)
 * consumes. The fields here are minimal but consistent with the
 * spec: thresholds for the adaptive zoom, and the wild-explorer
 * fraction. The shape is generic; Fractal Search fills in
 * behaviour-specific fields when it reads the policy at the
 * `GenomeBorn` handler.
 *
 * The seeds use stable UUIDs so re-bootstrapping is a no-op and
 * audits can reference a specific seed by id.
 */

import type { Database } from "bun:sqlite";

/**
 * Bump this when the seed set changes in a way that requires
 * re-seeding. Stored in `rsi_meta.strategy_seed_version`. The
 * default insert path is `INSERT OR IGNORE` so older seeds remain
 * stable across DB upgrades — only deliberate seed-set replacements
 * bump the version.
 */
export const STRATEGY_SEED_VERSION = "0.1.0-keystone";

export interface StrategyGenomeSeed {
  id: string;
  hyperparams: {
    mutation_rate: number;
    population_size: number;
    selection_pressure: number;
    zoom_policy: {
      coarse_threshold_high: number;
      coarse_threshold_low: number;
      fine_threshold_high: number;
      fine_threshold_low: number;
      wild_explorer_pct: number;
    };
  };
}

/**
 * The four seeds. Spread:
 *   1. conservative — small mutations, big population, gentle zoom.
 *   2. balanced     — middle-of-the-road profile.
 *   3. aggressive   — large mutations, small population, aggressive
 *                       zoom in promising regions.
 *   4. wild         — high mutation rate and a deliberately large
 *                       wild-explorer fraction so the strategy layer
 *                       can use this one to escape local optima.
 *
 * The UUIDs are stable across runs — generating fresh UUIDs each
 * boot would defeat the audit chain (a "new" seed at every boot
 * would look like the strategy layer was being silently reset).
 */
export const STRATEGY_SEEDS: readonly StrategyGenomeSeed[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    hyperparams: {
      mutation_rate: 0.05,
      population_size: 32,
      selection_pressure: 0.5,
      zoom_policy: {
        coarse_threshold_high: 8,
        coarse_threshold_low: 3,
        fine_threshold_high: 12,
        fine_threshold_low: 2,
        wild_explorer_pct: 0.05,
      },
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    hyperparams: {
      mutation_rate: 0.10,
      population_size: 16,
      selection_pressure: 1.0,
      zoom_policy: {
        coarse_threshold_high: 6,
        coarse_threshold_low: 2,
        fine_threshold_high: 10,
        fine_threshold_low: 2,
        wild_explorer_pct: 0.05,
      },
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    hyperparams: {
      mutation_rate: 0.25,
      population_size: 8,
      selection_pressure: 1.5,
      zoom_policy: {
        coarse_threshold_high: 4,
        coarse_threshold_low: 1,
        fine_threshold_high: 8,
        fine_threshold_low: 1,
        wild_explorer_pct: 0.10,
      },
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    hyperparams: {
      mutation_rate: 0.40,
      population_size: 6,
      selection_pressure: 2.0,
      zoom_policy: {
        coarse_threshold_high: 3,
        coarse_threshold_low: 1,
        fine_threshold_high: 6,
        fine_threshold_low: 1,
        wild_explorer_pct: 0.20,
      },
    },
  },
];

/**
 * Insert the four seeds if absent. Uses `INSERT OR IGNORE` so
 * re-running the bootstrap on an already-seeded DB is a no-op.
 * Returns the number of rows actually inserted (0 if everything
 * was already present).
 */
export function seedStrategyGenomes(db: Database): number {
  let inserted = 0;
  for (const seed of STRATEGY_SEEDS) {
    const result = db
      .query(
        `INSERT OR IGNORE INTO rsi_strategy_genome
           (id, hyperparams, ratchet_count, active, last_sync_at)
         VALUES ($id, $hp, 0, 1, NULL)
         RETURNING id`,
      )
      .get({
        $id: seed.id,
        $hp: JSON.stringify(seed.hyperparams),
      }) as { id: string } | null;
    if (result) inserted += 1;
  }
  // Persist the seed-version marker (best-effort — the meta table
  // is created on the fly if it doesn't exist yet).
  db.exec(`
    CREATE TABLE IF NOT EXISTS rsi_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.query(
    `INSERT INTO rsi_meta (key, value, updated_at) VALUES ($k, $v, $t)
     ON CONFLICT(key) DO UPDATE SET value = $v, updated_at = $t`,
  ).run({ $k: "strategy_seed_version", $v: STRATEGY_SEED_VERSION, $t: Date.now() });
  return inserted;
}

/**
 * Read the active strategy-genome population. Convenience wrapper
 * around `SELECT * FROM rsi_strategy_genome WHERE active = 1`. Used
 * by the PBT layer (Faza 3.5) once it lands; exposed now so
 * migrations and tests can verify the seed.
 */
export function listActiveStrategyGenomes(db: Database): StrategyGenomeSeed[] {
  const rows = db
    .query<
      { id: string; hyperparams: string },
      []
    >(
      `SELECT id, hyperparams FROM rsi_strategy_genome WHERE active = 1
       ORDER BY id`,
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    hyperparams: JSON.parse(r.hyperparams),
  }));
}
