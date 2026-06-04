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
 * Convert free text into a safe FTS5 query: extract word tokens and OR them
 * together as prefix matches. Returns null when nothing searchable remains.
 */
function toFtsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((t) => t.length > 1);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(" OR ");
}
