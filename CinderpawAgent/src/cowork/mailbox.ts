/**
 * Cowork mailbox repository (S2) — SQLite-backed A2A messaging.
 *
 * Pure persistence: no loop, no inference, no transport. The worker loop
 * (S3) decides WHEN to drain an inbox; the escalation transport (S4)
 * renders messages addressed to `"human"` where the user actually is.
 *
 * Prepared statements only — no SQL string building. Timestamps are epoch
 * milliseconds; ids are minted here (`randomUUID`), never trusted from
 * callers.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  CoworkMessage,
  CoworkMessageInput,
  CoworkMessageStatus,
} from "./types.ts";

interface MailboxRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  thread_id: string | null;
  body: string;
  payload_json: string | null;
  status: string;
  created_at: number;
  read_at: number | null;
}

export class CoworkMailboxRepo {
  readonly #insert: ReturnType<Database["query"]>;
  readonly #inbox: ReturnType<Database["query"]>;
  readonly #inboxByStatus: ReturnType<Database["query"]>;
  readonly #outbox: ReturnType<Database["query"]>;
  readonly #updateStatus: ReturnType<Database["query"]>;
  readonly #get: ReturnType<Database["query"]>;
  readonly #lastInThread: ReturnType<Database["query"]>;
  readonly #byThread: ReturnType<Database["query"]>;

  constructor(db: Database) {
    this.#insert = db.query(`
      INSERT INTO cowork_mailbox (
        id, from_agent_id, to_agent_id, thread_id,
        body, payload_json, status, created_at, read_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `);
    // `rowid DESC` is the deterministic tiebreak for messages written in
    // the same millisecond — insertion order is the only honest order left.
    this.#inbox = db.query(`
      SELECT * FROM cowork_mailbox
      WHERE to_agent_id = ?
      ORDER BY created_at DESC, rowid DESC
    `);
    this.#inboxByStatus = db.query(`
      SELECT * FROM cowork_mailbox
      WHERE to_agent_id = ? AND status = ?
      ORDER BY created_at DESC, rowid DESC
    `);
    // Oldest first: this is read back as a conversation, not an inbox.
    this.#byThread = db.query(`
      SELECT * FROM cowork_mailbox
      WHERE thread_id = ?
      ORDER BY created_at ASC, rowid ASC
    `);
    // Same deterministic tiebreak as the inbox queries.
    this.#lastInThread = db.query(`
      SELECT payload_json FROM cowork_mailbox
      WHERE thread_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `);
    this.#outbox = db.query(`
      SELECT * FROM cowork_mailbox
      WHERE from_agent_id = ?
      ORDER BY created_at DESC, rowid DESC
    `);
    // readAt is stamped on the FIRST transition out of pending and never
    // rewritten — COALESCE keeps the original even if the status moves on
    // to processed/rejected afterwards.
    this.#updateStatus = db.query(`
      UPDATE cowork_mailbox
      SET status = ?,
          read_at = CASE
            WHEN status = 'pending' AND ? IN ('read', 'processed') THEN ?
            ELSE read_at
          END
      WHERE id = ?
    `);
    this.#get = db.query(`SELECT * FROM cowork_mailbox WHERE id = ?`);
  }

  /** Insert a message. Returns the persisted message with its new id. */
  send(input: CoworkMessageInput): CoworkMessage {
    const message: CoworkMessage = {
      id: randomUUID(),
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      threadId: input.threadId ?? null,
      body: input.body,
      payloadJson: input.payloadJson ?? null,
      status: "pending",
      createdAt: Date.now(),
      readAt: null,
    };
    this.#insert.run(
      message.id,
      message.fromAgentId,
      message.toAgentId,
      message.threadId,
      message.body,
      message.payloadJson,
      message.createdAt,
    );
    return message;
  }

  /**
   * Messages addressed TO an agent (or `"human"`), newest first.
   * Optionally filtered by status — the worker loop drains `pending`.
   */
  inbox(toAgentId: string, status?: CoworkMessageStatus): CoworkMessage[] {
    const rows = (
      status
        ? this.#inboxByStatus.all(toAgentId, status)
        : this.#inbox.all(toAgentId)
    ) as MailboxRow[];
    return rows.map(fromRow);
  }

  /** Messages sent BY an agent, newest first. */
  outbox(fromAgentId: string): CoworkMessage[] {
    return (this.#outbox.all(fromAgentId) as MailboxRow[]).map(fromRow);
  }

  /** Move a message to a new status. Returns false if the id is unknown. */
  updateStatus(id: string, status: CoworkMessageStatus): boolean {
    const result = this.#updateStatus.run(status, status, Date.now(), id);
    return result.changes > 0;
  }

  /** Look up one message by id, or `undefined`. */
  /**
   * Every message in a thread, oldest first — the transcript, from disk.
   *
   * The panel was live-only: it accumulated `cowork_event`s in memory and lost
   * the lot on restart, so reopening a chat where teammates had worked showed
   * nothing. The rows were on disk the whole time; nothing read them back.
   */
  byThread(threadId: string): CoworkMessage[] {
    return (this.#byThread.all(threadId) as MailboxRow[]).map(fromRow);
  }

  /**
   * The hop count of the most recent message in a thread, or 0 for a thread
   * that does not exist yet.
   *
   * The hop cap lives on the THREAD, not on a session: the automatic reply
   * path in `runtime.ts` increments `coworkHops` in the payload, but a
   * teammate that answers by calling `cowork_send` instead was starting a
   * message with no payload at all — `readHops(null)` is 0, so the counter
   * reset and two agents could ping-pong without limit, each round costing a
   * full model turn. Reading the chain's current depth from the thread is
   * what makes the cap hold no matter which path sends the message.
   */
  lastHopsInThread(threadId: string | null): number {
    if (!threadId) return 0;
    const row = this.#lastInThread.get(threadId) as { payload_json: string | null } | null;
    if (!row?.payload_json) return 0;
    try {
      const parsed = JSON.parse(row.payload_json) as { coworkHops?: number };
      return typeof parsed.coworkHops === "number" && parsed.coworkHops >= 0
        ? Math.floor(parsed.coworkHops)
        : 0;
    } catch {
      return 0;
    }
  }

  get(id: string): CoworkMessage | undefined {
    const row = this.#get.get(id) as MailboxRow | null;
    return row ? fromRow(row) : undefined;
  }
}

function fromRow(r: MailboxRow): CoworkMessage {
  return {
    id: r.id,
    fromAgentId: r.from_agent_id,
    toAgentId: r.to_agent_id,
    threadId: r.thread_id,
    body: r.body,
    payloadJson: r.payload_json,
    status: r.status as CoworkMessageStatus,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}
