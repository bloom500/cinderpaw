/**
 * Turn checkpoint — the "walk away and come back" persistence layer.
 *
 * Working memory lives in RAM, per session. Episodic memory persists every
 * message, but tool results are truncated to 400 chars there (recall only
 * needs the gist), so replaying from episodic loses the actual file contents,
 * command output, and errors a mid-turn task depends on. If the sidecar dies
 * at iteration 7 of 15, that lossy replay is all a resumed session had — which
 * in practice meant starting over.
 *
 * This stores the FULL working-memory transcript after each tool call, keyed
 * by session, with a status. A turn in flight is `running`; a turn that
 * returned (normally, stopped, or out of time) is `done`. A `running` row that
 * outlives the process is exactly a crash: the next time that session builds
 * its working memory, it rehydrates from here instead of from lossy episodic,
 * and the model picks up with every completed step visible — so it does not
 * redo them. That last part is the idempotency story: the cheapest dedup is
 * the model seeing its own finished work, not a hash table of side effects.
 *
 * Shape mirrors TodoStore: a tiny class over one table, structural types, no
 * dependency on the agent-loop or tools layer.
 */

import type { Database } from "bun:sqlite";
import type { ChatMessage } from "../types.ts";
import { redactSecrets } from "./privacy.ts";

/**
 * Cap on the serialized transcript we persist per checkpoint. A turn can
 * accumulate large tool outputs (a 64 KB file read each); rewriting the whole
 * transcript after every tool call is already O(n²) over a turn, so an
 * unbounded row would make a pathological turn quadratically expensive in
 * bytes too. Past this we skip the checkpoint for that step rather than store
 * a giant blob — the previous checkpoint still stands, so at worst a crash
 * resumes one tool call earlier.
 *
 * ponytail: fixed 4 MB cap, whole-transcript rewrite. If long tasks with big
 * outputs start losing checkpoints, switch to an append-only per-step log;
 * the schema (one row per session) is deliberately the simple version first.
 */
export const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

/**
 * A model that has stopped writing and started looping: 120 or more identical
 * characters in a row.
 *
 * Ordinary text never does this. The longest legitimate run in prose is a few
 * dashes; separators in code reach a few dozen. The transcript that prompted
 * this guard carried one character repeated 2,334 times.
 *
 * A literal regex rather than one built from a constant — the escaping needed
 * to build a backreference from a string is exactly the kind of thing that
 * silently compiles into the wrong pattern.
 */
const DEGENERATE_RE = /(.)\1{119,}/u;

/**
 * Has this text collapsed into a repeated character?
 *
 * Deliberately dumb: one regex, no language detection, no model. A cleverer
 * detector would have opinions about what "good" output looks like, and a
 * checkpoint guard is the last place that should be making literary
 * judgements. It has to recognise one failure — the one that poisons the next
 * turn — and nothing else.
 */
export function looksDegenerate(text: string): boolean {
  return DEGENERATE_RE.test(text);
}

export type CheckpointStatus = "running" | "done";

export interface Checkpoint {
  sessionId: string;
  messageId: string;
  /** The loop iteration the checkpoint was taken at (for diagnostics/UX). */
  iteration: number;
  messages: ChatMessage[];
  status: CheckpointStatus;
  updatedAt: number;
}

interface CheckpointRow {
  session_id: string;
  message_id: string;
  iteration: number;
  messages: string;
  status: string;
  updated_at: number;
}

export class CheckpointStore {
  readonly #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Persist the current transcript as an in-flight checkpoint. Over the
   * primary key (session_id), so each step overwrites the last — we only ever
   * need the latest state to resume, not the history.
   *
   * Never throws: a checkpoint failure must not cost the user their turn, and
   * the turn is still correct without it (just not resumable). An oversized
   * transcript is skipped, not stored truncated — a truncated transcript would
   * resume the model into a corrupted context, worse than resuming one step
   * back.
   */
  save(args: { sessionId: string; messageId: string; iteration: number; messages: ChatMessage[] }): void {
    let json: string;
    try {
      json = JSON.stringify(args.messages);
    } catch {
      return;
    }
    // The third durable store. Episodic memory and the saved conversation are
    // both redacted (slices 11 and 12); this row was not, and it holds MORE
    // than they do — the full working-memory transcript, so a credential that
    // travelled as a tool argument or came back in a tool result is here even
    // when it never appeared in a user message.
    //
    // Redacting the serialized JSON rather than walking ChatMessage is
    // deliberate: one pass covers content, thinking, tool args and tool
    // results at once, and cannot miss a field someone adds to the type later.
    // It is safe on the wire shape because `[REDACTED:kind]` contains no
    // quote, backslash or control character, so the string stays valid JSON.
    //
    // The live turn keeps the real value — working memory is in RAM and is not
    // rewritten. Only a crash-resume loses it, and re-asking the user for a
    // token beats keeping their token in SQLite forever.
    json = redactSecrets(json).text;
    if (Buffer.byteLength(json, "utf8") > MAX_CHECKPOINT_BYTES) return;
    // A transcript that has collapsed into a repeated character must not be
    // stored, because storing it is how the failure spreads: the next turn
    // resumes from the checkpoint, the model reads its own loop as context,
    // and repeats it harder. That is how a single bad local reply became bad
    // replies from a cloud model with a 200k window — nothing about the model
    // was wrong, its context had been poisoned from disk.
    //
    // Skipping the write costs one step of resumability. Keeping it costs
    // every turn after it.
    if (looksDegenerate(json)) return;
    try {
      this.#db
        .query(
          `INSERT INTO session_checkpoint (session_id, message_id, iteration, messages, status, updated_at)
           VALUES ($s, $m, $i, $msgs, 'running', $t)
           ON CONFLICT(session_id) DO UPDATE SET
             message_id = excluded.message_id,
             iteration = excluded.iteration,
             messages = excluded.messages,
             status = 'running',
             updated_at = excluded.updated_at`,
        )
        .run({ $s: args.sessionId, $m: args.messageId, $i: args.iteration, $msgs: json, $t: Date.now() });
    } catch {
      // journal discipline — a write failure is not worth a thrown turn.
    }
  }

  /** Mark a session's turn finished. Idempotent; a no-op if none exists. */
  markDone(sessionId: string): void {
    try {
      this.#db
        .query("UPDATE session_checkpoint SET status = 'done', updated_at = $t WHERE session_id = $s")
        .run({ $s: sessionId, $t: Date.now() });
    } catch {
      /* ignore */
    }
  }

  /**
   * The in-flight checkpoint for a session, or null. Only `running` rows are
   * returned — a `done` turn is not something to resume. Corrupt JSON returns
   * null (start clean) rather than throwing.
   */
  loadRunning(sessionId: string): Checkpoint | null {
    let row: CheckpointRow | null;
    try {
      row = this.#db
        .query<CheckpointRow, [string]>(
          "SELECT session_id, message_id, iteration, messages, status, updated_at FROM session_checkpoint WHERE session_id = ? AND status = 'running'",
        )
        .get(sessionId);
    } catch {
      return null;
    }
    if (!row) return null;
    try {
      const messages = JSON.parse(row.messages) as ChatMessage[];
      if (!Array.isArray(messages)) return null;
      // Same check on the way out, because rows written before the guard
      // existed are still on disk. Starting clean is strictly better than
      // resuming into a loop.
      if (looksDegenerate(row.messages)) return null;
      return {
        sessionId: row.session_id,
        messageId: row.message_id,
        iteration: row.iteration,
        messages,
        status: "running",
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * All sessions with an in-flight turn — the crash survivors. A host UI can
   * surface these ("resume where you left off?"); the loop resumes them
   * automatically on the session's next access.
   */
  incomplete(): Array<{ sessionId: string; iteration: number; updatedAt: number }> {
    try {
      return this.#db
        .query<{ session_id: string; iteration: number; updated_at: number }, []>(
          "SELECT session_id, iteration, updated_at FROM session_checkpoint WHERE status = 'running' ORDER BY updated_at DESC",
        )
        .all()
        .map((r) => ({ sessionId: r.session_id, iteration: r.iteration, updatedAt: r.updated_at }));
    } catch {
      return [];
    }
  }
}
