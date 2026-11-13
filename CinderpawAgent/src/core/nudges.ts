import type { Database } from "bun:sqlite";

/**
 * The one door every message Cubby sends first goes through: unfinished-work
 * cards, fired tasks and watches, the evening digest, inner thoughts.
 * Replies to the person in the same turn are not nudges.
 *
 * Today it only records which channel delivered what, and when. Routing,
 * quiet hours, reactions and the rule come in later slices
 * (docs/superpowers/specs/2026-11-13-real-proactivity-design.md).
 */
export type NudgeKind = "followup" | "task" | "watch" | "digest" | "thought" | "receipt";

export interface NudgeInfo {
  kind: NudgeKind;
  sourceId?: string;
  sessionId?: string;
  /** A task or watch the person made. Never dropped or delayed. */
  userRequested?: boolean;
}

/** Returns the channel that delivered ("desktop" or a connector id), or null. */
export type Deliver = () => string | null | Promise<string | null>;

export class Nudges {
  readonly #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  async send(info: NudgeInfo, deliver: Deliver, now = Date.now()): Promise<string | null> {
    // Called first and synchronously, so a desktop event goes out in the same
    // order it did before this door existed.
    const channel = await deliver();
    // ponytail: only delivered messages are recorded. 'held_for_digest' and
    // 'dropped' rows arrive with the rule that makes those decisions.
    if (channel) this.#record(info, channel, now);
    return channel;
  }

  #record(info: NudgeInfo, channel: string, now: number): void {
    const id = crypto.randomUUID();
    // 1 in 5 skips the future rule, fixed by the id, so the rule can be judged.
    const arm = parseInt(id.slice(0, 8), 16) % 5 === 0 ? "control" : "rule";
    try {
      this.#db.query(
        `INSERT INTO nudges (id, kind, source_id, channel, session_id, created_at, sent_at, local_hour, arm, decision, user_requested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`,
      ).run(id, info.kind, info.sourceId ?? null, channel, info.sessionId ?? null, now, now,
        new Date(now).getHours(), arm, info.userRequested ? 1 : 0);
    } catch {
      // The ledger is for counting. A broken one must never stop a message.
    }
  }
}
