/**
 * One weekly spending limit for every scheduled agent task together.
 *
 * Off by default, like OpenClaw and Hermes Agent: the person runs their own
 * key, and the provider console is where a hard cap lives. The first task card
 * ever asks once whether they want one here too (24 Oct, Darius). Reminders and
 * watches run no model, so they never count.
 */
import type { Database } from "bun:sqlite";

const KEY = "tasks.weekly-limit.v1";
const WEEK = 7 * 24 * 3_600_000;

interface State { weeklyUsd: number | null; asked: boolean; spends: Array<{ at: number; usd: number }> }
export interface TaskLimitView { weeklyUsd: number | null; asked: boolean; spentUsd: number }

export class TaskLimit {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  #read(): State {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(KEY) as { value: string } | null;
    try {
      const s = row ? JSON.parse(row.value) as State : null;
      if (s && Array.isArray(s.spends)) return s;
    } catch { /* a damaged row reads as never asked, no limit */ }
    return { weeklyUsd: null, asked: false, spends: [] };
  }

  #write(s: State): void {
    const at = this.now();
    s.spends = s.spends.filter((x) => at - x.at < WEEK);
    this.db.query("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(KEY, JSON.stringify(s), at);
  }

  view(): TaskLimitView {
    const s = this.#read();
    const at = this.now();
    const spentUsd = s.spends.filter((x) => at - x.at < WEEK).reduce((sum, x) => sum + x.usd, 0);
    return { weeklyUsd: s.weeklyUsd, asked: s.asked, spentUsd };
  }

  /** null = no limit. Answering the first-card question counts as asked either way. */
  set(weeklyUsd: number | null): TaskLimitView {
    if (weeklyUsd !== null && !(Number.isFinite(weeklyUsd) && weeklyUsd > 0)) throw new Error("A weekly limit must be more than $0.");
    const s = this.#read();
    this.#write({ ...s, weeklyUsd, asked: true });
    return this.view();
  }

  record(usd: number): void {
    if (!(usd > 0)) return;
    const s = this.#read();
    s.spends.push({ at: this.now(), usd });
    this.#write(s);
  }

  /** What one more run may spend: Infinity with no limit. */
  remaining(): number {
    const v = this.view();
    return v.weeklyUsd === null ? Infinity : Math.max(0, v.weeklyUsd - v.spentUsd);
  }

  /** The sentence the person sees when a run is skipped, or null to run. */
  blockedReason(): string | null {
    const v = this.view();
    if (v.weeklyUsd === null || v.spentUsd < v.weeklyUsd) return null;
    return `Skipped: your weekly limit for scheduled tasks ($${v.weeklyUsd.toFixed(2)}) is used up. ` +
      "It frees up as older runs pass 7 days. Ask Cinderpaw to raise or remove the limit, or change it on the Tasks page.";
  }
}
