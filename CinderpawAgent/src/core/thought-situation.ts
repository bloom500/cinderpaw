/**
 * What the thought loop may talk about (spec slice 9): the person's open
 * watches, tasks due in the next day, work left unfinished this week, and how
 * the last 7 days of nudges went. Each item gets a short id the thought must
 * name, so a thought is always about something real (no filler).
 * Read from this computer only; no network, no model.
 */
import type { Database } from "bun:sqlite";
import type { CronJob } from "../types.ts";

export interface Situation {
  items: Array<{ id: string; line: string }>;
  /** Background, not something to talk about. */
  notes: string[];
}

const DAY = 24 * 3_600_000;
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function thoughtSituation(
  jobs: () => CronJob[],
  db: Database,
  week: () => { wroteFirst: number; answered: number },
  now = Date.now(),
): Situation {
  const items: Situation["items"] = [];
  const all = jobs().filter((j) => j.enabled);
  all.filter((j) => j.kind === "watch").slice(0, 5).forEach((j, i) => {
    const last = j.history.at(-1)?.result?.split("\n")[0];
    items.push({ id: `W${i + 1}`, line: `Watch "${short(j.name, 80)}"${last ? `, last check: ${short(last)}` : ", not checked yet"}` });
  });
  all.filter((j) => j.kind !== "watch" && j.nextRunMs && j.nextRunMs >= now && j.nextRunMs - now <= DAY).slice(0, 5).forEach((j, i) => {
    items.push({ id: `T${i + 1}`, line: `Task "${short(j.name, 80)}" runs ${new Date(j.nextRunMs!).toString().replace(/:\d\d GMT.*$/, "")}` });
  });
  try {
    const runs = db.query(`SELECT mission FROM runs WHERE status IN ('unfinished', 'needs_attention') AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 3`).all(now - 7 * DAY) as Array<{ mission: string }>;
    runs.filter((r) => r.mission?.trim()).forEach((r, i) => items.push({ id: `U${i + 1}`, line: `Unfinished: "${short(r.mission.trim())}"` }));
  } catch { /* no runs table yet */ }
  const w = week();
  const notes = [`Last 7 days: you wrote first ${w.wroteFirst} times; the person opened, answered or acted on ${w.answered}.`];
  return { items, notes };
}

/**
 * The thought must start with one of the ids in brackets, like "[W1] ...".
 * Returns the message without the tag, or null when it names nothing known.
 */
export function namedThought(thought: string, ids: ReadonlySet<string>): string | null {
  const m = /^\s*\[([A-Z]\d+)\]\s*/.exec(thought);
  if (!m || !ids.has(m[1]!)) return null;
  return thought.slice(m[0].length).trim() || null;
}
