import type { Database } from "bun:sqlite";

/**
 * The one door every message Cubby sends first goes through: unfinished-work
 * cards, fired tasks and watches, the evening digest, inner thoughts.
 * Replies to the person in the same turn are not nudges.
 *
 * It records which channel delivered what and when, what the person did
 * after, picks the one place that rings (`route`), and applies the rule that
 * learns when to stay quiet (spec 4.6, docs/superpowers/specs/2026-11-13-real-proactivity-design.md).
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

/**
 * The rule (spec 4.6): counting only, no model. Per kind and time of day, over
 * what was sent since the last Undo. Only what Cubby chose to say is ruled; a
 * task, a watch or the digest the person relies on is never held or dropped.
 */
export const RULE = {
  /** At least this many sent in a bucket before it can be held... */
  holdMinSent: 5,
  /** ...when under this share of them was answered, opened or acted on. */
  holdPositiveBelow: 0.2,
  /** At least this many sent, and at least `stopMinDismissed` dismissed: stop that kind at that time. */
  stopMinSent: 8,
  stopMinDismissed: 3,
} as const;
const RULED: ReadonlySet<NudgeKind> = new Set(["followup", "thought", "receipt"]);
const RESET_KEY = "proactive.rule-reset.v1";

export type Slot = "morning" | "afternoon" | "evening";
/** 08-12, 12-18, 18-22 local; null at night (quiet hours already keep it shut). */
export function slotOf(hour: number): Slot | null {
  return hour >= 8 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : hour >= 18 && hour < 22 ? "evening" : null;
}

/** Words for the person, used in the learned list and the digest. */
const ABOUT: Record<NudgeKind, string> = {
  followup: "unfinished work", thought: "my own thoughts", receipt: "the weekly summary",
  task: "tasks", watch: "watches", digest: "the daily summary",
};

export interface Learned { bucket: string; line: string }

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
  readonly #rule: boolean;
  readonly #digestOn: () => boolean;
  /**
   * `digestOn`: whether a daily digest exists to carry what is held; without
   * one the rule drops instead of holding (spec 4.5b). `rule: false` turns the
   * rule off (the replay test compares both).
   */
  readonly #newId: () => string;
  constructor(db: Database, o: { digestOn?: () => boolean; rule?: boolean; newId?: () => string } = {}) {
    this.#db = db;
    this.#digestOn = o.digestOn ?? (() => true);
    this.#rule = o.rule ?? true;
    // Tests pick ids, so which nudge lands in the control arm is fixed.
    this.#newId = o.newId ?? (() => crypto.randomUUID());
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
    const id = this.#newId();
    // 1 in 5 skips the rule, fixed by the id, so the rule can be judged.
    const arm = parseInt(id.slice(0, 8), 16) % 5 === 0 ? "control" : "rule";
    const decision = this.#decide(info, arm, now);
    if (decision !== "sent") {
      this.#record(info, id, arm, decision, null, now);
      return null;
    }
    // Called synchronously (the rule only reads), so a desktop event goes out
    // in the same order it did before this door existed.
    const channel = await deliver();
    if (channel) {
      this.expire(now);
      this.#record(info, id, arm, "sent", channel, now);
    }
    return channel;
  }

  #decide(info: NudgeInfo, arm: string, now: number): "sent" | "held_for_digest" | "dropped" {
    if (!this.#rule || arm === "control" || info.userRequested || !RULED.has(info.kind)) return "sent";
    const slot = slotOf(new Date(now).getHours());
    if (!slot) return "sent";
    try {
      const s = this.#stats(info.kind, slot);
      if (s.sent >= RULE.stopMinSent && s.dismissed >= RULE.stopMinDismissed) return "dropped";
      if (s.sent >= RULE.holdMinSent && s.positive / s.sent < RULE.holdPositiveBelow) return this.#digestOn() ? "held_for_digest" : "dropped";
    } catch { /* a broken ledger never stops a message */ }
    return "sent";
  }

  /** Counts for one bucket, over what was sent since its last Undo. */
  #stats(kind: NudgeKind, slot: Slot): { sent: number; positive: number; dismissed: number } {
    const since = this.#resets()[`${kind}:${slot}`] ?? 0;
    const [from, to] = slot === "morning" ? [8, 12] : slot === "afternoon" ? [12, 18] : [18, 22];
    const r = this.#db.query(`SELECT COUNT(*) AS sent,
        SUM(CASE WHEN outcome IN ('answered', 'opened', 'acted') THEN 1 ELSE 0 END) AS positive,
        SUM(CASE WHEN outcome = 'dismissed' THEN 1 ELSE 0 END) AS dismissed
      FROM nudges WHERE kind = ? AND decision = 'sent' AND local_hour >= ? AND local_hour < ? AND created_at > ?`)
      .get(kind, from, to, since) as { sent: number; positive: number | null; dismissed: number | null };
    return { sent: r.sent, positive: r.positive ?? 0, dismissed: r.dismissed ?? 0 };
  }

  #resets(): Record<string, number> {
    try {
      const row = this.#db.query(`SELECT value FROM meta WHERE key = ?`).get(RESET_KEY) as { value: string } | null;
      const parsed = row ? JSON.parse(row.value) : {};
      return parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
    } catch {
      return {};
    }
  }

  /** What Cubby learned to stop (spec 4.7), one plain line each, for the person to read and undo. */
  learned(): Learned[] {
    const out: Learned[] = [];
    if (!this.#rule) return out;
    for (const kind of RULED) {
      for (const slot of ["morning", "afternoon", "evening"] as const) {
        try {
          const s = this.#stats(kind, slot);
          if (s.sent >= RULE.stopMinSent && s.dismissed >= RULE.stopMinDismissed) {
            out.push({ bucket: `${kind}:${slot}`, line: `I stopped mentioning ${ABOUT[kind]} in the ${slot}. You closed it ${s.dismissed} times.` });
          }
        } catch { /* no ledger, nothing learned */ }
      }
    }
    return out;
  }

  /** Undo one learned line: that bucket's counts start again from now. */
  undo(bucket: string, now = Date.now()): void {
    const [kind, slot] = bucket.split(":");
    if (!RULED.has(kind as NudgeKind) || !["morning", "afternoon", "evening"].includes(slot ?? "")) return;
    this.#safe(() => {
      this.#db.query(`INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(RESET_KEY, JSON.stringify({ ...this.#resets(), [bucket]: now }), now);
    });
  }

  /** Lines for the next digest: what the rule held back since `since` (spec 4.5b). */
  heldSince(since: number, now = Date.now()): string[] {
    try {
      const rows = this.#db.query(`SELECT kind, COUNT(*) AS n FROM nudges WHERE decision = 'held_for_digest' AND created_at > ? AND created_at <= ? GROUP BY kind`)
        .all(since, now) as Array<{ kind: NudgeKind; n: number }>;
      return rows.map((r) => `• I kept ${r.n === 1 ? "one note" : `${r.n} notes`} about ${ABOUT[r.kind]} for this summary instead of writing at once.`);
    } catch {
      return [];
    }
  }

  /**
   * The two numbers the spec is judged by (section 1), from this computer's
   * ledger only. `answeredTwoWeeks`: the person answered, opened or acted on at
   * least one nudge in each of the last two weeks. `onTime`: the share of
   * things they asked for (tasks, watches) that went out when due; it must
   * never go down.
   */
  metrics(now = Date.now()): { answeredTwoWeeks: boolean; onTime: number | null; sent: number; held: number; dropped: number; ignored: number } {
    const WEEK = 7 * 24 * HOUR;
    const count = (sql: string, ...args: number[]) => (this.#db.query(sql).get(...args) as { n: number }).n;
    const positiveIn = (from: number, to: number) => count(`SELECT COUNT(*) AS n FROM nudges WHERE outcome IN ('answered', 'opened', 'acted') AND sent_at > ? AND sent_at <= ?`, from, to) > 0;
    const asked = count(`SELECT COUNT(*) AS n FROM nudges WHERE user_requested = 1`);
    const askedSent = count(`SELECT COUNT(*) AS n FROM nudges WHERE user_requested = 1 AND decision = 'sent'`);
    return {
      answeredTwoWeeks: positiveIn(now - WEEK, now) && positiveIn(now - 2 * WEEK, now - WEEK),
      onTime: asked ? askedSent / asked : null,
      sent: count(`SELECT COUNT(*) AS n FROM nudges WHERE decision = 'sent'`),
      held: count(`SELECT COUNT(*) AS n FROM nudges WHERE decision = 'held_for_digest'`),
      dropped: count(`SELECT COUNT(*) AS n FROM nudges WHERE decision = 'dropped'`),
      ignored: count(`SELECT COUNT(*) AS n FROM nudges WHERE outcome = 'ignored'`),
    };
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

  // A held or dropped nudge reached nobody: channel 'none', no sent_at.
  #record(info: NudgeInfo, id: string, arm: string, decision: string, channel: string | null, now: number): void {
    try {
      this.#db.query(
        `INSERT INTO nudges (id, kind, source_id, channel, session_id, created_at, sent_at, local_hour, arm, decision, user_requested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, info.kind, info.sourceId ?? null, channel ?? "none", info.sessionId ?? null, now, channel ? now : null,
        new Date(now).getHours(), arm, decision, info.userRequested ? 1 : 0);
    } catch {
      // The ledger is for counting. A broken one must never stop a message.
    }
  }
}
