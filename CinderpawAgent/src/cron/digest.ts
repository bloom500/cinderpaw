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

/** The digest for runs after `since`, or null when nothing ran. */
export function buildDigest(jobs: readonly CronJob[], since: number): string | null {
  const lines: string[] = [];
  let runs = 0;
  let bad = 0;
  for (const job of jobs) {
    const recent = job.history.filter((r) => r.runAt >= since && r.status !== "running");
    const last = recent.at(-1);
    if (!last) continue;
    runs += recent.length;
    if (BAD.has(last.status)) bad += 1;
    const what = job.kind === "watch" && last.status === "success" && last.proof ? "found it" : WORDS[last.status];
    const times = recent.length > 1 ? ` (${recent.length} runs)` : "";
    const why = BAD.has(last.status) && last.error ? `: ${last.error.replace(/\s+/g, " ").slice(0, 140)}` : "";
    lines.push(`${BAD.has(last.status) ? "⚠️" : "•"} ${job.name}: ${what} ${clock(last.runAt)}${times}${why}`);
  }
  if (runs === 0) return null;
  const head = `Your tasks, last 24 hours: ${runs} run${runs === 1 ? "" : "s"}` +
    (bad > 0 ? `, ${bad} need${bad === 1 ? "s" : ""} a look.` : ", all fine.");
  return [head, "", ...lines].join("\n");
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
  const text = buildDigest(opts.jobs(), now - DAY_MS);
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
