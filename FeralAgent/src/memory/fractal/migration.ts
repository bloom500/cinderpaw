/**
 * Migration — Pathway 3 step 2 Task 4.
 *
 * One-shot runner that lifts the ~41 pre-step-1 facts from
 * SemanticMemory into the reactive FractalMemory tree. After this
 * PR lands, every fact — new or migrated — flows through the same
 * `fractal.upsertLeaf(...)` path the Reconciler uses for live writes.
 *
 * Idempotency:
 *   - Marker `<dataDir>/fractal-migration-v1.done` is written
 *     atomically (tmp + rename) on success.
 *   - A present marker makes the next call a no-op (zero upserts,
 *     zero DB reads).
 *
 * Failure tolerance:
 *   - If any `upsertLeaf` throws, the marker is NOT written. The
 *     next boot retries the migration; upsertLeaf is idempotent on
 *     (text, first_seen_at) so duplicates are impossible.
 *   - If the embedder is unavailable (model missing), the migration
 *     reports an error and the marker stays absent. The reactive
 *     engine continues to work for NEW facts; the FTS5 fallback
 *     surfaces the old facts via auto-inject.
 *
 * Scope:
 *   - Facts only (SemanticMemory.all()). Observations live in
 *     EpisodicMemory and the tree picks them up on the next rebuild.
 *   - The migration is best-effort: it never throws to the caller.
 *     The caller (index.ts) awaits it at boot and logs the outcome.
 */

import { existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { SemanticMemory } from "../semantic.ts";
import type { EmbedInvoker } from "./embed.ts";

/**
 * Single source of truth for the marker file name. The string MUST
 * appear exactly once across the codebase — verify-then-grep in the
 * plan guards this.
 */
export const MIGRATION_MARKER_FILENAME = "fractal-migration-v1.done";

export interface MigrationDeps {
  /** Source of facts to migrate. */
  semantic: SemanticMemory;
  /**
   * The FractalMemory facade. `upsertLeaf` is the only call we make;
   * we never touch the tree or the pending set directly so this
   * dependency can be a stub in tests.
   */
  fractal: {
    upsertLeaf(opts: {
      text: string;
      embedding: number[];
      provenance: {
        source: string;
        first_seen_at: number;
        sessionId: string;
        ts: number;
        key?: string;
        value?: string;
      };
    }): Promise<{ kind: "grow"; leafId: number } | { kind: "seed"; leafId: number }>;
  };
  /**
   * Embedder — the same `embed(text) → vec` path the reactive engine and
   * the bench use. The migration computes the embedding for each fact
   * BEFORE calling `upsertLeaf` (which requires a non-empty embedding to
   * actually insert). When the model is missing on disk, `embed` returns
   * an empty array; the migration treats that as "retry next boot" and
   * does NOT write the marker.
   */
  embed: EmbedInvoker;
  /** Where the marker file lives. */
  dataDir: string;
}

export interface MigrationResult {
  /** True if migration actually ran (no marker was present). */
  ran: boolean;
  /** Number of facts processed (zero on no-op or error). */
  facts: number;
  /** Populated when ran=false because a prior call errored. */
  error?: string;
}

/**
 * Run the migration exactly once. Returns a result object; never throws.
 */
export async function runMigration(deps: MigrationDeps): Promise<MigrationResult> {
  const markerPath = join(deps.dataDir, MIGRATION_MARKER_FILENAME);

  if (existsSync(markerPath)) {
    return { ran: false, facts: 0 };
  }

  let facts;
  try {
    facts = deps.semantic.all();
  } catch (e) {
    return { ran: false, facts: 0, error: `semantic.all() failed: ${String(e)}` };
  }

  for (const fact of facts) {
    const text = `${fact.key}: ${fact.value}`;

    // Embed the fact first. upsertLeaf only inserts when handed a
    // non-empty embedding; an empty vector means the model is missing
    // on disk, so we abort WITHOUT writing the marker and the next boot
    // retries (the FTS5 fallback keeps the fact reachable meanwhile).
    let vec;
    try {
      const embedded = await deps.embed([text]);
      vec = embedded[0];
    } catch (e) {
      return { ran: false, facts: 0, error: `embed threw on "${fact.key}": ${String(e)}` };
    }
    if (!vec || vec.length === 0) {
      return { ran: false, facts: 0, error: `embedder unavailable (model missing) on "${fact.key}"` };
    }

    try {
      await deps.fractal.upsertLeaf({
        text,
        embedding: Array.from(vec),
        provenance: {
          source: "migration-v1",
          first_seen_at: fact.updatedAt,
          sessionId: "migration",
          ts: fact.updatedAt,
          key: fact.key,
          value: fact.value,
        },
      });
    } catch (e) {
      // Any upsertLeaf failure aborts the migration; marker stays absent.
      return {
        ran: false,
        facts: 0,
        error: `upsertLeaf threw on "${fact.key}": ${String(e)}`,
      };
    }
  }

  // Atomic marker write — tmp + rename. If rename fails (disk full,
  // permission denied, etc.) we report an error WITHOUT writing the
  // marker so the next boot retries.
  try {
    const tmpPath = `${markerPath}.tmp`;
    writeFileSync(tmpPath, "");
    renameSync(tmpPath, markerPath);
  } catch (e) {
    return {
      ran: false,
      facts: facts.length,
      error: `marker write failed: ${String(e)}`,
    };
  }

  return { ran: true, facts: facts.length };
}
