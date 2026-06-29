/**
 * Faza 1 — Async RSI Engine: production adapters for protocol (a).
 *
 * The ratchet handler and selection handler are pure: they take injected
 * functions for the git ops (`commitGenome`, `ratchetAttempt`) and the
 * population bookkeeping, and they don't know whether they're talking to
 * a stub (tests) or to Rust over the Feral Agent's stdin/stdout bridge.
 *
 * This module is the production wiring. It builds two adapters that the
 * ratchet handler consumes in production:
 *
 *   * `commitGenome(req)` — looks up `req.genomeId` in the population,
 *     composes the full `IterationMetadata` shape (score + token cost +
 *     duration from `req`, lineage + mutationType + config from the
 *     genome record), serialises the genome config to JSON, and sends
 *     `rsi_commit_genome` over the bridge. Resolves with the new commit
 *     hash from Rust.
 *
 *   * `ratchetAttempt(commitHash, score)` — sends `rsi_ratchet_attempt`
 *     and maps the Rust `RatchetResult` (`advanced`, `prior_score`) to
 *     the shape the ratchet handler expects (`advanced`, `previousBest`).
 *
 * The bridge itself is a thin correlation-id'd client (see `bridge.ts`);
 * the adapter just translates between the ratchet handler's vocabulary
 * and the Tauri command's parameter shape.
 *
 * Why the population lookup happens HERE and not in the ratchet handler:
 * the ratchet handler is intentionally dumb (it just routes events). The
 * adapter knows about the population and the database; that's the right
 * place for the "find genome, build metadata, send to Rust" logic, and
 * keeps the ratchet handler unit-testable without a bridge.
 */

import type { Database } from "bun:sqlite";
import type { RsiBridge } from "./bridge.ts";
import type { PopulationManager } from "./population-manager.ts";
import type { EvalOutcome } from "./eval-worker.ts";
import type { ScoreResult } from "./eval-worker.ts";

/**
 * Safety-net timeout for every bridge call. The RSI bridge ops are local
 * (git commit/ratchet, scoring, LCA) and resolve in milliseconds, but a
 * lost/mangled response line — interleaved stdout writes, or a write that
 * failed and was swallowed by the transport's `.catch(() => {})` — would
 * otherwise leave the Promise pending forever and permanently occupy an
 * eval-pool slot (goal-mode's `refill()` never fires for a frozen launch).
 * 30s is far above the real latency yet still frees the slot on a true loss.
 */
const BRIDGE_TIMEOUT_MS = 30_000;

/** What `commitGenome` returns to the ratchet handler. */
export interface CommitAck {
  /** SHA-1 hash of the new candidate commit (Rust's response). */
  commitHash: string;
}

/** What `ratchetAttempt` returns to the ratchet handler. */
export interface RatchetAck {
  /** True iff `main` advanced to the new commit. */
  advanced: boolean;
  /** The previous best score on main (None → -Infinity on the Rust side,
   *  normalised to 0 here so the ratchet handler's UI display is sane). */
  previousBest: number;
}

/** Dependencies for the bridge-based adapters. */
export interface BridgeAdapterDeps {
  bridge: RsiBridge;
  pop: PopulationManager;
  db: Database;
  /** Name of the active strategy (e.g. "pbt-v1"). Goes into the
   *  iteration metadata so audits can group iterations by strategy. */
  strategy: string;
}

/**
 * Build the production `commitGenome` adapter.
 *
 * Looks up the genome in the population by id (the ratchet handler
 * already received the genomeId from the EvalComplete event, but it
 * doesn't carry the config/lineage — those live here). Throws if the
 * genome is unknown; the ratchet handler's `try/catch` will surface
 * the error to the event bus as an EvalComplete with `errored: true`
 * (defensive — in practice the population is the source of truth so
 * the id should always exist).
 *
 * `genome_json` is a STRING (not an object) because the Rust side
 * parses it with `serde_json::from_str` and re-validates that it's a
 * JSON object before hashing — keeping the wire shape text matches
 * the existing `rsi_commit_genome` Tauri command exactly.
 *
 * Field naming: snake_case throughout the params because that's what
 * specta generates for the Tauri bindings and what `handle_rsi_request`
 * in Rust expects to deserialize. The bridge is intentionally a thin
 * JSON pipe — no camelCase translation layer.
 */
export function makeCommitGenomeAdapter(deps: BridgeAdapterDeps) {
  return async (req: {
    genomeId: string;
    score: number;
    tokenCost: number;
    durationMs: number;
  }): Promise<CommitAck> => {
    const g = deps.pop.get(req.genomeId);
    if (!g) {
      throw new Error(
        `commitGenome: unknown genome '${req.genomeId}' — population lookup failed`,
      );
    }
    // mutationType is REQUIRED by Rust's IterationMetadata; fall back
    // to "unknown" rather than crashing so a pre-7b-part2 genome
    // (added before this field existed) still produces an auditable
    // commit. The audit row will record the gap for forensics.
    const mutationType = g.mutationType ?? "unknown";
    const parentLineage = g.lineage;
    const configJson = g.config ?? {};

    // Candidate branch per genome — convention: `genome-<short-id>`.
    // Short id = first 8 hex chars of the UUID (same shape Rust's
    // `short_id_for_filename` uses, so a future commit-history
    // inspector can find both the snapshot file and the branch by
    // the same key).
    // NOTE: Rust's git validator requires single-segment branch names (no '/').
    const shortId = req.genomeId.replace(/-/g, "").slice(0, 8);
    const candidateBranch = `genome-${shortId}`;

    const result = await deps.bridge.request<{ commitHash: string }>(
      "rsi_commit_genome",
      {
        genome_id: req.genomeId,
        genome_json: JSON.stringify(configJson),
        parent_commits: [],
        metadata: {
          score: req.score,
          strategy: deps.strategy,
          parent_lineage: parentLineage,
          mutation_type: mutationType,
          cost_tokens: req.tokenCost,
          duration_ms: req.durationMs,
        },
        candidate_branch: candidateBranch,
      },
      BRIDGE_TIMEOUT_MS,
    );
    return { commitHash: result.commitHash };
  };
}

/**
 * Build the production `ratchetAttempt` adapter. Sends
 * `rsi_ratchet_attempt` over the bridge with the candidate commit
 * hash; Rust returns whether main advanced and the prior tip's score
 * (None on a fresh repo, normalised to 0 here).
 */
export function makeRatchetAttemptAdapter(deps: { bridge: RsiBridge }) {
  return async (
    commitHash: string,
    _score: number,
  ): Promise<RatchetAck> => {
    const result = await deps.bridge.request<{
      advanced: boolean;
      previous_tip: string | null;
      new_tip: string | null;
      candidate_score: number;
      prior_score: number | null;
    }>("rsi_ratchet_attempt", {
      candidate_commit: commitHash,
    }, BRIDGE_TIMEOUT_MS);
    return {
      advanced: result.advanced,
      previousBest: result.prior_score ?? 0,
    };
  };
}

/**
 * Build the production `scoreGenome` adapter the EvalWorker injects.
 *
 * Sends the eval batch to Rust's `rsi_score` over the bridge and unwraps
 * the composite. The sidecar NEVER computes the score itself — that
 * formula is the asymmetric-trust boundary the agent may not edit. The
 * bridge is a thin JSON pipe with no camelCase translation, so each TS
 * `EvalOutcome` (camelCase) is mapped to the snake_case shape Rust's
 * `EvalOutcome` deserialises (`task_id`, `latency_ms`, `error_message`).
 * `errorMessage` is normalised to `null` (not `undefined`) so the wire
 * payload always carries the field — matching Rust's `Option<String>`.
 */
export function makeScoreGenomeAdapter(deps: { bridge: RsiBridge; log?: (msg: string) => void }) {
  return async (outcomes: EvalOutcome[]): Promise<ScoreResult> => {
    const wire = outcomes.map((o) => ({
      task_id: o.taskId,
      tier: o.tier,
      success: o.success,
      latency_ms: o.latencyMs,
      tokens: o.tokens,
      errored: o.errored,
      error_message: o.errorMessage ?? null,
    }));
    try {
      const result = await deps.bridge.request<{ score: number }>("rsi_score", {
        outcomes: wire,
      }, BRIDGE_TIMEOUT_MS);
      return { score: result.score };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log?.(`rsi_score bridge error: ${detail} (${outcomes.length} outcomes)`);
      throw err;
    }
  };
}

/**
 * Build the production `hasRecentCommonAncestor` adapter the
 * crossover-selection pair picker injects (via
 * `SelectionDeps.crossover.selectPairs`'s `CrossoverSelectionDeps`).
 *
 * Resolves each genome id to its git commit hash (recorded by the
 * ratchet handler after every successful commit) and asks Rust for
 * the LCA over the bridge. The bridge surfaces `rsi_lca` which returns
 * `{ "lca": Option<String> }` — we treat `null` (and any bridge
 * error) as "no common ancestor" so the pair is filtered out by
 * `selectCrossoverPairs`. Two genomes that share a commit hash
 * (rare but possible if a genome was re-evaluated and re-committed
 * to the same hash) are treated as trivially related.
 *
 * The "recent" qualifier in the name is currently a soft check —
 * any LCA is considered recent enough. A future PBT phase can
 * layer on a recency window by inspecting the LCA's age from
 * `rsi_log` (the commit history).
 */
export function makeLcaAdapter(deps: {
  bridge: RsiBridge;
  pop: PopulationManager;
}) {
  return async (idA: string, idB: string): Promise<boolean> => {
    const hashA = deps.pop.getCommitHash(idA);
    const hashB = deps.pop.getCommitHash(idB);
    if (!hashA || !hashB) return false; // uncommitted → can't compute LCA
    if (hashA === hashB) return true; // identical commit → trivially related

    try {
      const result = await deps.bridge.request<{ lca: string | null }>(
        "rsi_lca",
        { a: hashA, b: hashB },
        BRIDGE_TIMEOUT_MS,
      );
      return result.lca !== null;
    } catch {
      // Bridge failure (e.g. Rust rejects one of the hashes, the
      // substrate is mid-mutation, or the connection dropped).
      // Conservative: refuse the pair so a transient bridge error
      // can never widen the search by accident.
      return false;
    }
  };
}
