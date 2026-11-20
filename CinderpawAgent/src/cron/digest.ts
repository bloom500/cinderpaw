/**
 * One message a day of what the tasks did (27 Oct, Darius: "nici macar mie nu
 * mi-a castigat increderea" for automations). Built from run history, no model:
 * what ran, what a watch found, what failed and why. A failure no longer waits
 * for the person to open the app and read a red row. A day on which nothing
 * ran sends nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cinderpawHome } from "../config.ts";
import type { CronJob, CronRunRecord } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How a run ended, in words for the person. `running` is not reported. */
const WORDS: Record<CronRunRecord["status"], string> = {
  success: "done",
  incomplete: "stopped partway",
  failed: "failed",
  timeout: "took too long",
  budget_exceeded: "stopped at its spending limit",
  skipped: "skipped",
  waiting: "waiting",
  expired: "expired",
  running: "",
};

const BAD = new Set<CronRunRecord["status"]>(["failed", "timeout", "budget_exceeded", "incomplete"]);

const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);

/**
 * The digest for runs after `since`, plus `held`: lines for what the rule kept
 * back for it (spec 4.5b). Null when nothing ran and nothing was held.
 */
export function buildDigest(jobs: readonly CronJob[], since: number, held: readonly string[] = []): string | null {
  const lines: string[] = [];
  let runs = 0;
  let bad = 0;
  for (const job of jobs) {
    const recent = job.history.filter((r) => r.runAt >= since && r.status !== "running");
    const last = recent.at(-1);
    if (!last) continue;
    // A watch is one line, not one per hourly check. "No change" alone is not
    // news: a day with only that sends nothing.
    if (job.kind === "watch" && last.status === "waiting") {
      lines.push(`• Still watching: ${job.name}. No change.`);
      continue;
    }
    runs += recent.length;
    if (BAD.has(last.status)) bad += 1;
    const what = job.kind === "watch" && last.status === "success" && last.proof ? "found it" : WORDS[last.status];
    const times = recent.length > 1 ? ` (${recent.length} runs)` : "";
    const why = BAD.has(last.status) && last.error ? `: ${last.error.replace(/\s+/g, " ").slice(0, 140)}` : "";
    lines.push(`${BAD.has(last.status) ? "⚠️" : "•"} ${job.name}: ${what} ${clock(last.runAt)}${times}${why}`);
  }
  if (runs === 0 && held.length === 0) return null;
  if (runs === 0) return ["Your day", "", ...held].join("\n");
  const head = `Your tasks, last 24 hours: ${runs} run${runs === 1 ? "" : "s"}` +
    (bad > 0 ? `, ${bad} need${bad === 1 ? "s" : ""} a look.` : ", all fine.");
  return [head, "", ...lines, ...(held.length ? ["", ...held] : [])].join("\n");
}

/**
 * The weekly receipt (spec slice 7): what Cubby did this week, in numbers, no
 * model. Null when there is nothing to tell (no task ran, nothing was sent).
 */
export function buildReceipt(jobs: readonly CronJob[], week: { wroteFirst: number; answered: number }, since: number): string | null {
  let runs = 0;
  let checks = 0;
  let found = 0;
  for (const job of jobs) {
    const recent = job.history.filter((r) => r.runAt >= since && r.status !== "running");
    if (job.kind === "watch") {
      checks += recent.length;
      found += recent.filter((r) => r.status === "success" && r.proof).length;
    } else runs += recent.length;
  }
  if (runs === 0 && checks === 0 && week.wroteFirst === 0) return null;
  const lines = ["Your week with Cinderpaw", ""];
  if (runs) lines.push(`• Tasks ran ${runs} time${runs === 1 ? "" : "s"}.`);
  if (checks) lines.push(`• I checked your watched pages ${checks} time${checks === 1 ? "" : "s"}${found ? ` and found what you wanted ${found} time${found === 1 ? "" : "s"}` : ""}.`);
  if (week.wroteFirst) lines.push(`• I wrote to you first ${week.wroteFirst} time${week.wroteFirst === 1 ? "" : "s"}; you answered or opened ${week.answered}.`);
  lines.push("", "These numbers stay on this computer.");
  return lines.join("\n");
}

/** Send the weekly receipt once, on Sunday at or after `hour`. Same contract as `maybeSendDigest`. */
export async function maybeSendReceipt(opts: {
  hour: number;
  jobs: () => readonly CronJob[];
  week: () => { wroteFirst: number; answered: number };
  send: (text: string) => Promise<string | null>;
  now?: number;
  file?: string;
}): Promise<string | null> {
  const now = opts.now ?? Date.now();
  const d = new Date(now);
  if (opts.hour < 0 || d.getDay() !== 0 || d.getHours() < opts.hour) return null;
  const today = d.toDateString();
  const file = opts.file ?? join(cinderpawHome(), "agent", "receipt-sent");
  try {
    if (existsSync(file) && readFileSync(file, "utf8").trim() === today) return null;
  } catch { /* unreadable: send, at worst twice */ }
  const text = buildReceipt(opts.jobs(), opts.week(), now - 7 * DAY_MS);
  if (!text) return null;
  const via = await opts.send(text);
  // Marked when it reached someone, or when the rule held or dropped it: asked once a week either way.
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, today);
  } catch { /* not fatal */ }
  return via ? text : null;
}

/** The day the last digest went out, so a restart does not send it twice. */
function sentFile(): string {
  return join(cinderpawHome(), "agent", "digest-sent");
}

/**
 * Send today's digest once, at or after `hour` local time. Returns what was
 * sent, or null (too early, already sent today, nothing ran, nobody to send to).
 */
export async function maybeSendDigest(opts: {
  hour: number;
  jobs: () => readonly CronJob[];
  send: (text: string) => Promise<string | null>;
  /** What the rule held back since `since`, one line each (Nudges.heldSince). */
  held?: (since: number) => string[];
  now?: number;
  file?: string;
}): Promise<string | null> {
  const now = opts.now ?? Date.now();
  if (opts.hour < 0 || new Date(now).getHours() < opts.hour) return null;
  const today = new Date(now).toDateString();
  const file = opts.file ?? sentFile();
  try {
    if (existsSync(file) && readFileSync(file, "utf8").trim() === today) return null;
  } catch { /* unreadable: send, at worst twice */ }
  const text = buildDigest(opts.jobs(), now - DAY_MS, opts.held?.(now - DAY_MS) ?? []);
  if (!text) return null;
  const via = await opts.send(text);
  // Marked only when it reached someone: with no messenger yet, a later one
  // that connects tonight still gets today's digest.
  if (via) {
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, today);
    } catch { /* not fatal */ }
  }
  return via ? text : null;
}
