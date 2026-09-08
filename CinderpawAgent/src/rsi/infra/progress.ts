/**
 * Improvement telemetry — "the plot". Aggregates the Evolution Journal's
 * per-day JSONL files into a longitudinal time series: is the RSI loop
 * actually compounding, or just churning?
 *
 * Pure read-side aggregation over data the journal already records —
 * nothing new is written. Per day: cycle count, accept/reject/halt
 * split, mean aggregate score of evaluated candidates, mean confidence.
 * The caller (self_progress tool, UI event) draws the curve; the trend
 * summary here is the honest headline a researcher would ask for.
 */

import { readJournal, journalFilename } from "./journal.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ProgressDay {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  cycles: number;
  accepted: number;
  rejected: number;
  halted: number;
  /** Mean `result.aggregate` over cycles that reached Evaluate; null
   *  when none did. */
  meanAggregate: number | null;
  /** Mean confidence over the same cycles; null when none. */
  meanConfidence: number | null;
  /** True when the day's journal file exists but cannot be read (a corrupt
   *  row — readJournal throws per INVARIANT I4). Counts stay zero, but the
   *  flag keeps the day from rendering like a day the agent did nothing:
   *  same zeros, opposite meaning. A missing file is a genuinely empty
   *  day and reads false. */
  corrupt: boolean;
}

export interface ProgressSeries {
  days: ProgressDay[];
  /** Days that actually had cycles. */
  activeDays: number;
  totalCycles: number;
  totalAccepted: number;
  /** Trend: mean aggregate of the last active day minus the first
   *  active day. Positive = the loop is climbing. Null with <2 active
   *  days that measured an aggregate. */
  aggregateTrend: number | null;
}

/** Aggregate the last `days` UTC days of journal files under `journalDir`.
 *  Missing files are simply empty days — a fresh install draws a flat
 *  zero line, never throws. Files that exist but fail to parse are
 *  marked `corrupt` on their day (counts stay zero) so they never read
 *  as quiet days. */
export function improvementSeries(journalDir: string, days: number, now: Date = new Date()): ProgressSeries {
  const n = Math.max(1, Math.min(365, Math.floor(days)));
  const out: ProgressDay[] = [];

  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const path = join(journalDir, journalFilename(d));
    let entries: ReturnType<typeof readJournal> = [];
    let corrupt = false;
    if (existsSync(path)) {
      try {
        entries = readJournal(path);
      } catch {
        // Corrupt day file → zero counts AND the flag (journal discipline:
        // readJournal throws on a corrupt row instead of thinning the day).
        corrupt = true;
      }
    }
    const evaluated = entries.filter((e) => e.result !== null);
    const aggregates = evaluated.map((e) => e.result!.aggregate);
    const confidences = evaluated.map((e) => e.result!.confidence);
    out.push({
      date: isoDate(d),
      cycles: entries.length,
      accepted: entries.filter((e) => e.decided.action === "accept").length,
      rejected: entries.filter((e) => e.decided.action === "reject").length,
      halted: entries.filter((e) => e.decided.action === "halt").length,
      meanAggregate: mean(aggregates),
      meanConfidence: mean(confidences),
      corrupt,
    });
  }

  const active = out.filter((d) => d.cycles > 0);
  const measured = active.filter((d) => d.meanAggregate !== null);
  const first = measured[0]?.meanAggregate ?? null;
  const last = measured[measured.length - 1]?.meanAggregate ?? null;
  return {
    days: out,
    activeDays: active.length,
    totalCycles: out.reduce((s, d) => s + d.cycles, 0),
    totalAccepted: out.reduce((s, d) => s + d.accepted, 0),
    aggregateTrend:
      measured.length >= 2 && first !== null && last !== null ? last - first : null,
  };
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
