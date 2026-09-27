/**
 * What a new conversation already knows: the user card (or the facts, until
 * the Reflector has written a card), the recent notes grouped by day, and the
 * weekly digests. Built once per session and appended to the system prompt,
 * where it stays byte-identical for the whole conversation: providers cache
 * it and llama-server reuses its KV (see WorkingMemory.setSnapshot).
 *
 * The header starts with `## ` on purpose. Providers cut the `## Available
 * tools` section out of the system prompt when native tools are on, and the
 * cut runs to the next `## ` heading; a snapshot without one would be cut too.
 *
 * Pure. Spec: docs/superpowers/specs/2026-09-27-observational-memory-design.md
 */
import type { Note } from "./observations.ts";

export const SNAPSHOT_HEADER = "## What you remember";

const DAY = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MARK = { high: "🔴", med: "🟡", low: "🟢" } as const;
const RANK = { high: 0, med: 1, low: 2 } as const;

export interface SnapshotInput {
  now: number;
  card: string | null;
  facts: ReadonlyArray<{ key: string; value: string }>;
  /** Undigested notes, the current session already left out. */
  notes: readonly Note[];
  digests: readonly Note[];
  budgetChars: number;
}

/** 8% of the transcript budget, in chars, between 2000 and 8000. */
export function snapshotBudgetChars(transcriptBudgetTokens: number): number {
  return Math.max(2000, Math.min(8000, Math.floor(transcriptBudgetTokens * 4 * 0.08)));
}

const day = (ts: number) => Math.floor(ts / DAY);
const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function ago(now: number, ts: number): string {
  const d = day(now) - day(ts);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

const noteLine = (n: Note) => `- ${MARK[n.priority]} ${n.text}${n.refDate ? ` (for ${n.refDate})` : ""}`;

export function buildSnapshot(i: SnapshotInput): string {
  const about = i.card?.trim()
    ? i.card.trim()
    : i.facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
  if (!about && i.notes.length === 0 && i.digests.length === 0) return "";

  const d = new Date(i.now);
  const out: string[] = [
    `${SNAPSHOT_HEADER} (today is ${stamp(i.now)}, ${WEEKDAYS[d.getUTCDay()]})`,
    "Background from earlier conversations with this user. Use it when it helps; do not recite it.",
  ];
  let used = out.join("\n").length;
  const fits = (line: string) => used + 1 + line.length <= i.budgetChars;
  const push = (line: string) => {
    out.push(line);
    used += 1 + line.length;
  };

  if (about && fits("About the user:")) {
    push("About the user:");
    for (const line of about.split("\n")) {
      if (!fits(line)) break;
      push(line);
    }
  }

  // Choose newest first (high first within a day), then show oldest first.
  const byRecency = [...i.notes].sort(
    (a, b) => day(b.observedAt) - day(a.observedAt) || RANK[a.priority] - RANK[b.priority] || b.observedAt - a.observedAt,
  );
  const header = "Recent notes:";
  let left = i.budgetChars - used - 1 - header.length;
  const chosen: Note[] = [];
  const days = new Set<number>();
  for (const n of byRecency) {
    const dayHeader = `${stamp(n.observedAt)} (${ago(i.now, n.observedAt)})`;
    const cost = noteLine(n).length + 1 + (days.has(day(n.observedAt)) ? 0 : dayHeader.length + 1);
    if (cost > left) break;
    left -= cost;
    days.add(day(n.observedAt));
    chosen.push(n);
  }
  if (chosen.length > 0) {
    push(header);
    let current = -1;
    for (const n of [...chosen].sort((a, b) => a.observedAt - b.observedAt || RANK[a.priority] - RANK[b.priority])) {
      if (day(n.observedAt) !== current) {
        current = day(n.observedAt);
        push(`${stamp(n.observedAt)} (${ago(i.now, n.observedAt)})`);
      }
      push(noteLine(n));
    }
  }

  const earlier: string[] = [];
  let earlierUsed = used + 1 + "Earlier:".length;
  for (const g of i.digests) {
    const line = `- ${g.period}: ${g.text}`;
    if (earlierUsed + 1 + line.length > i.budgetChars) break;
    earlierUsed += 1 + line.length;
    earlier.unshift(line);
  }
  if (earlier.length > 0) {
    push("Earlier:");
    for (const line of earlier) push(line);
  }
  return out.join("\n");
}
