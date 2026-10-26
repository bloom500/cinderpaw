import type { Database } from "bun:sqlite";
import { InferenceSpendAuthority, type InferencePrice, type SpendTarget } from "../egress/inference-spend-authority.ts";
import type { RunStore } from "./run-store.ts";
import { redactSecrets, stripPrivate } from "../memory/privacy.ts";

export interface FollowUp { id: string; sessionId: string; mission: string }
const FOLLOWUPS_KEY = "proactive.followups.v1";
const BUDGET_KEY = "proactive.monthly-spend.v1";
const HOUR = 3_600_000;

function read<T>(db: Database, key: string, fallback: T): T {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  try { return row ? JSON.parse(row.value) as T : fallback; } catch { return fallback; }
}
function write(db: Database, key: string, value: unknown, now: number): void {
  db.query("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(key, JSON.stringify(value), now);
}

/** A lifecycle event asks once; no timers, inference, or automatic resumption. */
export class FollowUpLedger {
  constructor(private readonly db: Database) {}

  take(now = Date.now()): FollowUp | null {
    const day = new Date(now).toISOString().slice(0, 10);
    const state = read<{ seen: string[]; last: number; day: string; count: number }>(this.db, FOLLOWUPS_KEY, { seen: [], last: 0, day, count: 0 });
    if (!state || !Array.isArray(state.seen) || (state.last && now - state.last < 4 * HOUR) || (state.day === day && state.count >= 3)) return null;
    const rows = this.db.query(`SELECT r.id, r.session_id, r.mission FROM runs r
      WHERE r.status IN ('unfinished', 'needs_attention')
        AND r.stopped_because IN ('deadline', 'not_continuable', 'process_died', 'resume_cap', 'continuation_budget', 'no_progress')
        AND r.updated_at <= ? AND r.updated_at >= ?
        AND json_valid(r.delivery) AND json_extract(r.delivery, '$.kind') = 'desktop'
        AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.session_id = r.session_id
          AND (newer.updated_at > r.updated_at OR (newer.updated_at = r.updated_at AND newer.rowid > r.rowid)))
      ORDER BY r.updated_at DESC LIMIT 20`).all(now - 10 * 60_000, now - 7 * 24 * HOUR) as Array<{ id: string; session_id: string; mission: string }>;
    const row = rows.find((r) => !state.seen.includes(r.id) && r.mission.trim());
    if (!row) return null;
    write(this.db, FOLLOWUPS_KEY, { seen: [...state.seen, row.id].slice(-512), last: now, day, count: (state.day === day ? state.count : 0) + 1 }, now);
    return { id: row.id, sessionId: row.session_id, mission: row.mission.slice(0, 1000) };
  }
}

/** Record an ordinary chat's terminal verdict without enabling autonomous mode
 * or taking a safety snapshot. The row is created AND closed synchronously;
 * it is evidence for suggestions, never a boot-time instruction to resume.
 */
export function recordInteractiveTurn(store: RunStore, sessionId: string, mission: string, outcome: string, report: string, db?: Database): void {
  // Cleaned like every other place a chat is kept (agent-loop), and short: a
  // pasted key went in whole and stayed forever (24 Oct review). The card shows
  // at most 1,000 characters of the mission; the report is only for the record.
  const clean = (text: string, max: number) => stripPrivate(redactSecrets(text).text).text.slice(0, max);
  mission = clean(mission, 1000);
  report = clean(report, 2000);
  // Suggestions are offered for 7 days at most; older chat rows are dead weight.
  db?.query(`DELETE FROM runs WHERE continuation_budget = 0 AND safety_root IS NULL AND updated_at < ?
    AND json_valid(delivery) AND json_extract(delivery, '$.kind') = 'desktop'`).run(Date.now() - 7 * 24 * HOUR);
  const row = store.startRun({ sessionId, mission, deadlineAt: Date.now(), continuationBudget: 0,
    safetyRoot: null, safetyBefore: null, safetyGitDir: null, doneWhen: null,
    delivery: { kind: "desktop", target: sessionId, sessionId } });
  if (!row) return;
  const reason = outcome === "completed" ? "completed" : outcome === "stopped" ? "user_stopped"
    : outcome === "out_of_time" || outcome === "ceiling" ? "deadline" : outcome === "stuck" ? "no_progress" : "not_continuable";
  store.finish(row.id, outcome === "completed" ? "finished" : "unfinished", reason, report);
  store.markDelivered(row.id);
}

/** The legacy opt-in reflection loop shares this monthly cap, never task spend.
 * Reserve the remaining month durably BEFORE provider work. A process crash
 * consumes the reservation conservatively instead of granting another dollar.
 */
export class MonthlyProactiveBudget {
  #busy = false;
  constructor(private readonly db: Database, private readonly options: {
    price: (target: SpendTarget) => InferencePrice | null;
    now?: () => number;
    limitUsd?: () => number;
  }) {}

  spent(): number {
    const month = new Date(this.#now()).toISOString().slice(0, 7);
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(BUDGET_KEY) as { value: string } | null;
    if (!row) return 0;
    try {
      const state = JSON.parse(row.value) as { month: string; spent: number } | null;
      if (!state || !/^\d{4}-\d{2}$/.test(state.month) || !Number.isFinite(state.spent) || state.spent < 0) return Infinity;
      return state.month === month ? state.spent : 0;
    } catch { return Infinity; }
  }

  async run<T>(call: (authority: InferenceSpendAuthority) => Promise<T>): Promise<T> {
    const now = this.#now();
    const month = new Date(now).toISOString().slice(0, 7);
    const configured = this.options.limitUsd?.() ?? 1;
    const limit = Number.isFinite(configured) && configured >= 0 ? configured : 0;
    const before = this.spent();
    if (this.#busy || before >= limit) throw new Error("Automatic proactive spending stopped at its monthly limit.");
    this.#busy = true;
    const authority = new InferenceSpendAuthority({ maxCostUsd: limit - before, allowCloud: true, price: this.options.price });
    write(this.db, BUDGET_KEY, { month, spent: limit }, now);
    try {
      return await call(authority);
    } finally {
      // Open holds are charged, too: a caller must never turn an unaccounted
      // physical request into a free call merely by throwing before settlement.
      write(this.db, BUDGET_KEY, { month, spent: before + authority.spentUsd + authority.reservedUsd }, this.#now());
      this.#busy = false;
    }
  }

  #now(): number { return this.options.now?.() ?? Date.now(); }
}
