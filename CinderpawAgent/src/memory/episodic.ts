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

/**
 * Marker row written by `AgentLoop.resetSession` (`/new`). Everything a session
 * recorded before its most recent marker is excluded from `conversation()`.
 *
 * A reset cannot just drop the in-RAM WorkingMemory: the next message rebuilds
 * it, and rebuilding replays the last 40 turns straight back out of this table
 * (AgentLoop.#memoryFor) — the "fresh start" lasted exactly one message. The
 * barrier is what makes the reset stick. Nothing is deleted: the rows stay
 * searchable by recall, they just stop being replayed as live conversation.
 */
export const SESSION_RESET_MARK = "[session-reset]";

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
  readonly #isPrivate: ((sessionId: string) => boolean) | null;

  constructor(
    db: Database,
    audit: AuditLogger,
    getWorkspaceId?: () => string | null,
    /**
     * Resolves "this session is not the owner" at WRITE time, so no caller has
     * to thread a flag through every record(). Same injection shape as
     * getWorkspaceId above. Omitted (tests, legacy callers) = everything is
     * the owner's, which is the pre-existing behaviour.
     * Production passes `isRestrictedSession` — see core/session-visibility.ts.
     */
    isPrivate?: (sessionId: string) => boolean,
  ) {
    this.#db = db;
    this.#audit = audit;
    this.#getWorkspaceId = getWorkspaceId ?? null;
    this.#isPrivate = isPrivate ?? null;
    this.#insert = db.query(`
      INSERT INTO episodic (session_id, timestamp, role, content, workspace_id, private)
      VALUES ($sessionId, $timestamp, $role, $content, $workspaceId, $private)
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
        $private: this.#isPrivate?.(sessionId) ? 1 : 0,
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
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, limit);
    return rows.map(fromRow).reverse();
  }

  /**
   * The last `limit` REPLAYABLE turns of a session, oldest-first — the shape a
   * cold WorkingMemory rehydrates from (see AgentLoop.#memoryFor).
   *
   * Not the same query as `recent()`, deliberately:
   *   - `tool` rows are included, but ONLY as evidence that work happened —
   *     the caller collapses them to a one-line note. Their content is
   *     truncated to 400 chars and carries no call id, so replaying them as
   *     real tool messages would be a malformed, lossy tool history. Excluding
   *     them outright, which is what this did before, was worse: the replayed
   *     transcript then showed forty turns of the agent answering questions
   *     about files with no sign of ever having opened one — including for
   *     turns that had opened plenty. Measured consequence, not theory: the
   *     same model, same prompt, same tools called `read_file` with no history
   *     and refused to call anything with those forty turns in front of it,
   *     while forty turns of unrelated chat left it calling the tool. It was
   *     copying the only pattern its own transcript showed it.
   *   - MemoryExtractor's observation notes are excluded. It records them with
   *     role `assistant` under the live sessionId (extractor.ts), so replaying
   *     them would feed the model its own internal `[obs:…]` notes as things
   *     it said out loud.
   *   - Anything older than the session's most recent `[session-reset]` marker
   *     is excluded. That is what makes `/new` survive the rehydration path —
   *     see SESSION_RESET_MARK.
   * All three are filtered in SQL, not after the fact, so `limit` counts real
   * turns — a session whose last 40 rows are all tool calls still rehydrates 40
   * turns of conversation.
   */
  conversation(sessionId: string, limit = 20): EpisodicEvent[] {
    const rows = this.#db
      .query<EpisodicRow, [string, string, string, number]>(
        `SELECT id, session_id, timestamp, role, content
         FROM episodic
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
           AND content NOT LIKE '[obs:%'
           AND id > COALESCE(
             (SELECT MAX(id) FROM episodic
               WHERE session_id = ? AND role = 'system' AND content = ?),
             0)
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, sessionId, SESSION_RESET_MARK, limit);
    if (rows.length === 0) return [];
    // Tool rows are fetched in a second pass rather than by widening the query
    // above, so `limit` keeps counting real conversation turns: a session whose
    // last 40 rows are all tool calls still rehydrates 40 turns of talk. The
    // window is the id range the conversation rows already span.
    const oldest = rows.reduce((min, r) => (r.id < min ? r.id : min), rows[0]!.id);
    const tools = this.#db
      .query<EpisodicRow, [string, number]>(
        `SELECT id, session_id, timestamp, role, content
         FROM episodic
         WHERE session_id = ? AND role = 'tool' AND id >= ?`,
      )
      .all(sessionId, oldest);
    return [...rows, ...tools].map(fromRow).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  /**
   * Every OWNER event across all sessions, oldest-first, capped at `limit`.
   * Used by Fractal Memory Search to (re)build the RAPTOR tree over the whole
   * corpus — which is why non-owner rows are excluded here too and not only in
   * `search()`: the tree backs the same `recall` tool, so indexing a stranger's
   * turn would reintroduce the leak through the semantic path after the
   * keyword path was closed.
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
         WHERE private = 0
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
   *
   * Non-owner rows (`private = 1`) are excluded: this is the query that
   * crosses session boundaries, so it is exactly where a public lead's
   * transcript would otherwise reach the owner. Per-session reads
   * (`recent`/`conversation`) are unfiltered — a lead still gets their own
   * thread back.
   */
  search(query: string, limit = 10): EpisodicEvent[] {
    const strict = this.#searchWith(toFtsQuery(query, "and"), limit);
    if (strict.length > 0) return strict;
    // Widen. ANDing every token means each word of the query must appear in
    // the row, which a natural-language question essentially never satisfies:
    // "Where is the staging database password kept" scored zero against a row
    // that literally contained the answer, because "where", "kept" and "is"
    // were not in it. That is the shape every caller actually uses — the
    // `recall` tool passes the user's question, and so does the per-turn
    // injection — so the strict pass alone made memory look empty while it
    // was full.
    //
    // Precision first, recall second: the AND pass still wins when it matches,
    // and the OR pass is ordered by bm25, whose IDF weighting already pushes
    // common words like "where" and "is" down on its own. No stopword list,
    // which would have to be per-language and would quietly fail for anyone
    // not working in English.
    return this.#searchWith(toFtsQuery(query, "or"), limit);
  }

  /** Run one FTS match. A null match or a malformed query yields no rows
   *  rather than throwing — recall must never cost a turn. */
  #searchWith(match: string | null, limit: number): EpisodicEvent[] {
    if (!match) return [];
    try {
      const rows = this.#db
        .query<EpisodicRow, [string, number]>(
          `SELECT e.id, e.session_id, e.timestamp, e.role, e.content
           FROM episodic_fts f
           JOIN episodic e ON e.id = f.rowid
           WHERE episodic_fts MATCH ?
             AND e.private = 0
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
 * matching.
 *
 * `mode` decides how the tokens are joined, and `search` uses both: "and"
 * demands every term (precise, and empty for any query phrased as a sentence),
 * "or" demands one (finds the row, and leans on bm25 to rank the good matches
 * above the ones that only share a "the"). An earlier version offered only the
 * AND join while its docstring claimed an OR fallback that was never written.
 */
function toFtsQuery(text: string, mode: "and" | "or" = "and"): string | null {
  const tokens = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .flatMap((t) => t.split(/[^\p{L}\p{N}_]+/u))
    .filter((t) => t.length > 1)
    .map((t) => `"${t.replace(/"/g, "")}"`);  // quote each token, strip embedded quotes

  if (tokens.length === 0) return null;
  const prefixed = tokens.map((t) => `${t}*`);
  if (prefixed.length === 1) return prefixed[0]!;
  return prefixed.join(mode === "or" ? " OR " : " ");
}
