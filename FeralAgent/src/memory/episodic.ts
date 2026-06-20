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

  constructor(db: Database, audit: AuditLogger) {
    this.#db = db;
    this.#audit = audit;
    this.#insert = db.query(`
      INSERT INTO episodic (session_id, timestamp, role, content)
      VALUES ($sessionId, $timestamp, $role, $content)
    `);
  }

  /** Persist a single event and audit the memory write. */
  record(sessionId: string, role: ChatMessage["role"], content: string): void {
    if (!content.trim()) return;
    try {
      this.#insert.run({
        $sessionId: sessionId,
        $timestamp: Date.now(),
        $role: role,
        $content: content,
      });
      this.#audit({
        timestamp: Date.now(),
        sessionId,
        actionType: "memory_write",
        result: "success",
        argsJson: JSON.stringify({ role, length: content.length }),
      });
    } catch (err) {
      this.#audit({
        timestamp: Date.now(),
        sessionId,
        actionType: "memory_write",
        result: "error",
        blockedReason: String(err),
      });
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
   */
  all(limit = 50_000): EpisodicEvent[] {
    const rows = this.#db
      .query<EpisodicRow, [number]>(
        `SELECT id, session_id, timestamp, role, content
         FROM episodic
         ORDER BY timestamp ASC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map(fromRow);
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
}

function fromRow(row: EpisodicRow): EpisodicEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    role: row.role as ChatMessage["role"],
    content: row.content,
  };
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
