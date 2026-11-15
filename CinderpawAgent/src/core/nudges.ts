import type { Database } from "bun:sqlite";

/**
 * The one door every message Cubby sends first goes through: unfinished-work
 * cards, fired tasks and watches, the evening digest, inner thoughts.
 * Replies to the person in the same turn are not nudges.
 *
 * It records which channel delivered what and when, what the person did
 * after, and picks the one place that rings (`route`). The rule comes in a
 * later slice (docs/superpowers/specs/2026-11-13-real-proactivity-design.md).
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

export type NudgeOutcome = "ignored" | "opened" | "answered" | "acted" | "dismissed";

const HOUR = 3_600_000;
/** A phone reply counts as an answer for this long after the nudge. */
const ANSWER_WINDOW_MS = 12 * HOUR;
/** No reaction by then: ignored. Also how long writing in the chat counts as acting on it. */
const IGNORE_AFTER_MS = 24 * HOUR;
/** "At the computer": the window was focused, or the person wrote in the app, this recently. */
const PRESENT_MS = 10 * 60_000;

/** 22:00-08:00 local. No watch checks, and nothing Cubby chose to say goes out. */
export function quietHour(at: number): boolean {
  const h = new Date(at).getHours();
  return h >= 22 || h < 8;
}

/** The ways one nudge can reach the person (see `Nudges.route`). */
export interface Ways {
  /** Sends to the owner's phone; the connector that delivered, or null. */
  phone?: (() => Promise<string | null>) | null;
  /** Always runs. `rang` is the phone that already rang (stay quiet), or null (ring here). */
  desktop: (rang: string | null) => void;
  /** The person asked for this on their phone: it goes there even while they are at the computer. */
  phoneAsked?: boolean;
}

// A stronger outcome replaces a weaker one: acted > answered > opened > ignored.
// Nothing replaces dismissed, and dismissed does not replace answered or acted:
// closing a card after using it is not saying no.
const RANK_SQL = `CASE outcome WHEN 'ignored' THEN 0 WHEN 'opened' THEN 1 WHEN 'answered' THEN 2 WHEN 'acted' THEN 3 ELSE 9 END`;
const RANK: Record<Exclude<NudgeOutcome, "dismissed">, number> = { ignored: 0, opened: 1, answered: 2, acted: 3 };

export class Nudges {
  readonly #db: Database;
  // ponytail: in memory. After an engine restart the person counts as away
  // until the window reports focus again, which it does when it opens.
  #lastSeen = 0;
  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * The "This week" card on the Today page (spec 4.13): how often the agent
   * wrote first in the last 7 days, how often the person opened, answered or
   * acted on it, and the sends per day, oldest first, the last being today.
   * Read from this computer's ledger only; nothing leaves it (4.12).
   */
  week(now = Date.now()): { wroteFirst: number; answered: number; days: number[] } {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const from = today.getTime() - 6 * 24 * 60 * 60_000;
    const rows = this.#db.query(`SELECT sent_at, outcome FROM nudges WHERE sent_at >= ? AND sent_at <= ?`)
      .all(from, now) as Array<{ sent_at: number; outcome: string | null }>;
    const days = [0, 0, 0, 0, 0, 0, 0];
    for (const r of rows) {
      const day = new Date(r.sent_at); day.setHours(0, 0, 0, 0);
      const i = Math.round((day.getTime() - from) / (24 * 60 * 60_000));
      if (i >= 0 && i < 7) days[i]! += 1;
    }
    const answered = rows.filter((r) => r.outcome === "opened" || r.outcome === "answered" || r.outcome === "acted").length;
    return { wroteFirst: rows.length, answered, days };
  }

  /** The window was focused, or the person wrote in the app. */
  seen(now = Date.now()): void {
    this.#lastSeen = now;
  }

  atComputer(now = Date.now()): boolean {
    return now - this.#lastSeen <= PRESENT_MS;
  }

  /**
   * One ringer, not one place: the phone when the person is away and the phone
   * answers, otherwise the desktop. The desktop part always runs, so a task's
   * result still lands in the chat when the phone rang instead.
   */
  route(info: NudgeInfo, ways: Ways, now = Date.now()): Promise<string | null> {
    return this.send(info, () => {
      if (!ways.phone || (this.atComputer(now) && !ways.phoneAsked)) {
        ways.desktop(null);
        return "desktop";
      }
      const phone = ways.phone;
      return Promise.resolve().then(phone).catch(() => null).then((rang) => {
        ways.desktop(rang);
        return rang ?? "desktop";
      });
    }, now);
  }

  async send(info: NudgeInfo, deliver: Deliver, now = Date.now()): Promise<string | null> {
    // Called first and synchronously, so a desktop event goes out in the same
    // order it did before this door existed.
    const channel = await deliver();
    // ponytail: only delivered messages are recorded. 'held_for_digest' and
    // 'dropped' rows arrive with the rule that makes those decisions.
    if (channel) {
      this.expire(now);
      this.#record(info, channel, now);
    }
    return channel;
  }

  // Reactions are resolved lazily, when something happens (a message in, a
  // send, boot). No timers. Like #record, a broken ledger never throws.

  /** The owner wrote in their own chat on `channel` (a connector id). */
  inbound(channel: string, now = Date.now()): void {
    this.#safe(() => {
      this.expire(now);
      const open = this.#db.query(
        `SELECT id, sent_at FROM nudges WHERE channel = ? AND outcome IS NULL AND sent_at <= ? ORDER BY sent_at DESC, rowid DESC`,
      ).all(channel, now) as Array<{ id: string; sent_at: number }>;
      const [latest, ...older] = open;
      // Only the most recent nudge can be what they are answering; the ones
      // before it went unanswered.
      if (latest && now - latest.sent_at <= ANSWER_WINDOW_MS) this.#set(latest.id, "answered", now);
      else if (latest) older.unshift(latest);
      for (const n of older) this.#set(n.id, "ignored", now);
    });
  }

  /** Cubby said something else in the owner's chat: a reply now answers that. */
  outbound(channel: string, now = Date.now()): void {
    this.#safe(() => {
      this.#db.query(`UPDATE nudges SET outcome = 'ignored', outcome_at = ? WHERE channel = ? AND outcome IS NULL AND sent_at <= ?`)
        .run(now, channel, now);
    });
  }

  /** The desktop card for `sourceId` was opened or dismissed. */
  react(sourceId: string, outcome: "opened" | "dismissed", now = Date.now()): void {
    this.#safe(() => {
      for (const n of this.#db.query(`SELECT id FROM nudges WHERE source_id = ?`).all(sourceId) as Array<{ id: string }>) {
        this.#set(n.id, outcome, now);
      }
    });
  }

  /** The person wrote in `sessionId`: unfinished work offered there was continued. */
  continued(sessionId: string, now = Date.now()): void {
    this.#safe(() => {
      const rows = this.#db.query(
        `SELECT id FROM nudges WHERE kind = 'followup' AND session_id = ? AND sent_at <= ? AND sent_at > ?`,
      ).all(sessionId, now, now - IGNORE_AFTER_MS) as Array<{ id: string }>;
      for (const n of rows) this.#set(n.id, "acted", now);
    });
  }

  /** Nothing happened within a day: ignored. */
  expire(now = Date.now()): void {
    this.#safe(() => {
      this.#db.query(`UPDATE nudges SET outcome = 'ignored', outcome_at = ? WHERE outcome IS NULL AND sent_at <= ?`)
        .run(now, now - IGNORE_AFTER_MS);
    });
  }

  #set(id: string, outcome: NudgeOutcome, now: number): void {
    const weaker = outcome === "dismissed"
      ? `(outcome IS NULL OR outcome IN ('ignored', 'opened'))`
      : `(outcome IS NULL OR (outcome != 'dismissed' AND ${RANK_SQL} < ${RANK[outcome]}))`;
    this.#db.query(`UPDATE nudges SET outcome = ?, outcome_at = ? WHERE id = ? AND ${weaker}`).run(outcome, now, id);
  }

  #safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // The ledger is for counting. A broken one must never stop a message.
    }
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
