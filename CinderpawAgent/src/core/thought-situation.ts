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
  owner?: { id: string; name: string; role: string };
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
  owner?: Situation["owner"],
): Situation {
  const items: Situation["items"] = [];
  const all = jobs().filter((j) => j.enabled && (j.ownerAgentId ?? null) === (owner?.id ?? null));
  all.filter((j) => j.kind === "watch").slice(0, 5).forEach((j, i) => {
    const last = j.history.at(-1)?.result?.split("\n")[0];
    items.push({ id: `W${i + 1}`, line: `Watch "${short(j.name, 80)}"${last ? `, last check: ${short(last)}` : ", not checked yet"}` });
  });
  all.filter((j) => j.kind !== "watch" && j.nextRunMs && j.nextRunMs >= now && j.nextRunMs - now <= DAY).slice(0, 5).forEach((j, i) => {
    items.push({ id: `T${i + 1}`, line: `Task "${short(j.name, 80)}" runs ${new Date(j.nextRunMs!).toString().replace(/:\d\d GMT.*$/, "")}` });
  });
  try {
    const runs = db.query(`SELECT mission FROM runs r WHERE status IN ('unfinished', 'needs_attention') AND updated_at >= ?
      AND stopped_because != 'user_stopped'
      AND ((? IS NULL AND session_id NOT LIKE 'cowork:%') OR session_id = ?)
      AND NOT EXISTS (SELECT 1 FROM runs later WHERE later.session_id = r.session_id
        AND (later.updated_at > r.updated_at OR (later.updated_at = r.updated_at AND later.rowid > r.rowid)))
      ORDER BY updated_at DESC LIMIT 3`).all(now - 7 * DAY, owner?.id ?? null, owner ? `cowork:${owner.id}` : null) as Array<{ mission: string }>;
    runs.filter((r) => r.mission?.trim()).forEach((r, i) => items.push({ id: `U${i + 1}`, line: `Unfinished: "${short(r.mission.trim())}"` }));
  } catch { /* no runs table yet */ }
  const w = week();
  const notes = [`Last 7 days: you wrote first ${w.wroteFirst} times; the person opened, answered or acted on ${w.answered}.`];
  return { items, notes, ...(owner ? { owner } : {}) };
}

/** One eligible speaker per tick. Teammates share the existing inference and interruption limits. */
export function teamThoughtSituation(
  roster: () => NonNullable<Situation["owner"]>[],
  read: (owner?: Situation["owner"]) => Situation,
): () => Situation {
  let last: string | undefined;
  return () => {
    const speakers = [undefined, ...roster()];
    const start = last === undefined ? 0 : (speakers.findIndex((s) => (s?.id ?? '') === last) + 1) % speakers.length;
    for (let offset = 0; offset < speakers.length; offset++) {
      const owner = speakers[(start + offset) % speakers.length];
      const situation = read(owner);
      if (situation.items.length) {
        last = owner?.id ?? '';
        return situation;
      }
    }
    return { items: [], notes: [] };
  };
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
