/**
 * Episodic memory — the durable, searchable record of past events.
 *
 * Every user message, assistant reply, and tool result is persisted to the
 * `episodic` table and mirrored into an FTS5 index (`episodic_fts`, maintained
 * by triggers in db.ts). Past conversations can be recalled by full-text query
 * to ground future responses.
 */

import type { Database } from "bun:sqlite";
import type { AuditLogger, ChatMessage, EpisodicEvent } from "../types.ts";

export class EpisodicMemory {
  readonly #db: Database;
  readonly #audit: AuditLogger;
  readonly #insert: ReturnType<Database["query"]>;
  readonly #getWorkspaceId: (() => string | null) | null;

  /**
   * `getWorkspaceId` resolves the active workspace at write time so every
   * `record()` is scoped without each caller having to thread the id through.
   * Null (tests, legacy callers) writes an unscoped row — same as before.
   */
  constructor(db: Database, audit: AuditLogger, getWorkspaceId?: () => string | null) {
    this.#db = db;
    this.#audit = audit;
    this.#getWorkspaceId = getWorkspaceId ?? null;
    this.#insert = db.query(`
      INSERT INTO episodic (session_id, timestamp, role, content, workspace_id)
      VALUES ($sessionId, $timestamp, $role, $content, $workspaceId)
    `);
  }

  /**
   * Persist a single event and audit the memory write. Returns the inserted
   * row id (or `null` on error / empty content) so callers can wire the new
   * leaf into other systems — most notably the FractalMemory `noteWrite`
   * pulse that drives the organism on every memory write.
   */
  record(sessionId: string, role: ChatMessage["role"], content: string): number | null {
    if (!content.trim()) return null;
    try {
      const ts = Date.now();
      this.#insert.run({
        $sessionId: sessionId,
        $timestamp: ts,
        $role: role,
        $content: content,
        $workspaceId: this.#getWorkspaceId?.() ?? null,
      });
      // `lastInsertRowid` exists at runtime on bun:sqlite's `Database` but
      // isn't surfaced on the TypeScript types, so go through a one-shot
      // query that hits SQLite's built-in function instead.
      const row = this.#db
        .query<{ id: number }, []>("SELECT last_insert_rowid() AS id")
        .get();
      const id = row?.id ?? null;
      this.#audit({
        timestamp: ts,
        sessionId,
        actionType: "memory_write",
        result: "success",
        argsJson: JSON.stringify({ role, length: content.length }),
      });
      return id;
    } catch (err) {
      this.#audit({
        timestamp: Date.now(),
        sessionId,
        actionType: "memory_write",
        result: "error",
        blockedReason: String(err),
      });
      return null;
    }
  }

  /** The most recent events for a session, oldest-first. */
  recent(sessionId: string, limit = 20): EpisodicEvent[] {
    const rows = this.#db
      .query<EpisodicRow, [string, number]>(
        `SELECT id, session_id, timestamp, role, content
         FROM episodic
         WHERE session_id = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(sessionId, limit);
    return rows.map(fromRow).reverse();
  }

  /**
   * Every event across all sessions, oldest-first, capped at `limit`. Used by
   * Fractal Memory Search to (re)build the RAPTOR tree over the whole corpus.
   * The cap bounds memory for very large histories; offline tree-building
   * tolerates a ceiling, and FTS5 still covers anything beyond it.
   *
   * The returned events carry `embedding` whenever the row already has one
   * stored — the RAPTOR builder uses that to skip re-embedding the corpus on
   * every rebuild. Rows with no embedding yet come back with `embedding:
   * undefined` and are embedded on demand by the tree builder.
   */
  all(limit = 50_000): EpisodicEvent[] {
    const rows = this.#db
      .query<EpisodicRow, [number]>(
        `SELECT id, session_id, timestamp, role, content, embedding
         FROM episodic
         ORDER BY timestamp ASC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map(fromRow);
  }

  /**
   * Persist freshly-computed embeddings for the given rows. One UPDATE per
   * row, all in a single transaction so a partial write can't leave the
   * table half-updated (a crash mid-flight is fine — the next rebuild just
   * re-embeds whatever didn't land).
   *
   * The on-disk format is a raw little-endian f32 BLOB (4 bytes per float,
   * no length prefix). It matches what `embed` produces and what
   * `decodeVec` reads back; changing it would break every existing database.
   * Rows with empty / zero-length vectors are skipped — those are not valid
   * embeddings and we'd rather leave the column NULL than write garbage.
   */
  setEmbeddings(rows: { id: number; vec: Float32Array }[]): void {
    if (rows.length === 0) return;
    const update = this.#db.query(
      `UPDATE episodic SET embedding = ? WHERE id = ?`,
    );
    const tx = this.#db.transaction((batch: { id: number; vec: Float32Array }[]) => {
      for (const row of batch) {
        if (!row.vec || row.vec.length === 0) continue;
        // Fresh copy out of the caller's buffer so SQLite sees a stable
        // backing store (Float32Array.buffer can be a SharedArrayBuffer in
        // pathological cases; the .slice() also detaches from any pooled
        // ArrayBuffer the runtime may reuse).
        const vecCopy = row.vec.slice();
        const bytes = new Uint8Array(vecCopy.buffer, vecCopy.byteOffset, vecCopy.byteLength);
        update.run(bytes, row.id);
      }
    });
    tx(rows);
  }

  /**
   * Drop every stored embedding (set the column NULL), returning how many rows
   * were cleared. Used when the embedding model changes: the stored vectors'
   * dimensionality no longer matches the new model, so they must be discarded
   * and re-embedded. The text is untouched — only the vectors are dropped.
   *
   * The count is computed by a SELECT before the UPDATE because the FTS5
   * `episodic_au` trigger fires from this same UPDATE and bumps SQLite's
   * `sqlite3_changes()` counter far beyond the actual number of `episodic`
   * rows modified — each FTS5 maintenance insert is counted, so on this
   * schema the bare `changes` value is meaningless. A pre-count is the
   * cheapest, most honest fix; the Sprint 1.10 tests pin it.
   */
  clearEmbeddings(): number {
    const before = this.#db
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM episodic WHERE embedding IS NOT NULL`,
      )
      .get();
    if (!before || before.n === 0) return 0;
    this.#db
      .query(`UPDATE episodic SET embedding = NULL WHERE embedding IS NOT NULL`)
      .run();
    return before.n;
  }

  /**
   * Full-text search across all sessions. Returns the best-matching events,
   * most relevant first. The query is sanitized into an FTS5 prefix-OR query so
   * arbitrary user text never produces a syntax error.
   */
  search(query: string, limit = 10): EpisodicEvent[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    try {
      const rows = this.#db
        .query<EpisodicRow, [string, number]>(
          `SELECT e.id, e.session_id, e.timestamp, e.role, e.content
           FROM episodic_fts f
           JOIN episodic e ON e.id = f.rowid
           WHERE episodic_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(match, limit);
      return rows.map(fromRow);
    } catch {
      // A malformed match should never crash recall.
      return [];
    }
  }
}

interface EpisodicRow {
  id: number;
  session_id: string;
  timestamp: number;
  role: string;
  content: string;
  /**
   * Raw little-endian f32 BLOB from SQLite. Bun's driver returns this as a
   * `Uint8Array`; absent columns come back as `null` (legacy rows + any row
   * that hasn't been embedded yet).
   */
  embedding: Uint8Array | null;
}

/**
 * Decode a stored embedding BLOB into a Float32Array view. Returns
 * `undefined` for NULL, empty, or misaligned (byteLength % 4 !== 0) input
 * — those rows have to be re-embedded rather than treated as a zero vector.
 *
 * The BLOB's backing buffer is owned by SQLite and may be reused between
 * queries, so we `.slice()` to copy out before constructing the typed-array
 * view. Otherwise two consecutive `all()` calls could end up aliasing the
 * same Float32Array and silently corrupt the previous one.
 */
function decodeVec(blob: Uint8Array | null | undefined): Float32Array | undefined {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return undefined;
  const copy = blob.slice(); // detach from sqlite's reused buffer
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function fromRow(row: EpisodicRow): EpisodicEvent {
  const ev: EpisodicEvent = {
    id: row.id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    role: row.role as ChatMessage["role"],
    content: row.content,
  };
  const vec = decodeVec(row.embedding);
  if (vec) ev.embedding = vec;
  return ev;
}

/**
 * Convert free text into a safe FTS5 query.
 *
 * Adapted from claude-mem (thedotmack/claude-mem): normalise to NFKC first so
 * accented / composed characters (e.g. Romanian ș, ă) are folded to their base
 * forms before tokenisation. Each token is double-quoted so it is treated as a
 * literal phrase rather than an FTS5 operator, then suffixed with * for prefix
 * matching. Tokens are ANDed so all terms must appear (higher precision than OR).
 * Falls back to OR when only one token is found.
 */
function toFtsQuery(text: string): string | null {
  const tokens = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .flatMap((t) => t.split(/[^\p{L}\p{N}_]+/u))
    .filter((t) => t.length > 1)
    .map((t) => `"${t.replace(/"/g, "")}"`);  // quote each token, strip embedded quotes

  if (tokens.length === 0) return null;
  // Single token → prefix match; multiple → AND for precision, OR suffix for recall
  if (tokens.length === 1) return `${tokens[0]}*`;
  return tokens.map((t) => `${t}*`).join(" ");
}
