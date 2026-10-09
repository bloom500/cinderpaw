import type { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cinderpawHome } from "../config.ts";
import { VERSION } from "../runtime-meta.ts";
import { rollup, type UsageGroup } from "./usage-rollup.ts";

/** Same worker as the install counter (src-tauri/src/commands/system.rs). */
export const USAGE_URL = "https://cinderpaw-bug-report.bloommediacorporation.workers.dev/usage";
const DAY_MS = 86_400_000;
const MAX_DAYS_BACK = 30;
const EVERY_MS = 6 * 3_600_000;

export interface UsagePayload { v: 1; code: string; day: string; app: string; os: string; groups: UsageGroup[] }

export function appVersion(): string {
  return VERSION;
}
export function osLabel(): string {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "other";
}

/**
 * The person's answer, read from settings.json every time (no cache), so
 * switching it off in Settings stops the very next send. null = never asked.
 * Same file the host writes; see core/permission-mode.ts for the pattern.
 */
export function sharingSetting(): boolean | null {
  try {
    const v = (JSON.parse(readFileSync(join(cinderpawHome(), "settings.json"), "utf8")) as { usage_sharing?: unknown }).usage_sharing;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

const codePath = () => join(cinderpawHome(), "usage-code.json");
const sentPath = () => join(cinderpawHome(), "telemetry-sent.jsonl");
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A random code per calendar month (UTC). It lets the server count
 * installations per month and refuse to add one machine's day twice, and it
 * cannot follow anyone across months. `since` is the first day sharing was on:
 * days collected before the person said yes are never sent.
 *
 * The code is picked by the month of the DAY being sent, not the send time: a
 * day only leaves after it ends, so 31 Oct goes out on 1 Nov and must still be
 * the same October install. File: `{codes: {"2026-10": "<hex>"}, since}`.
 * Months older than the 30-day window are dropped.
 */
export function monthlyCode(now: Date, day = utcDay(now.getTime())): { code: string; since: string } {
  let file: { codes?: unknown; since?: unknown; month?: unknown; code?: unknown } = {};
  try { file = JSON.parse(readFileSync(codePath(), "utf8")); } catch { /* first time */ }
  // Builds up to 8 Oct 2026 kept one code: {month, code, since}.
  const stored = file.codes && typeof file.codes === "object" ? (file.codes as Record<string, unknown>)
    : typeof file.month === "string" ? { [file.month]: file.code } : {};
  const oldest = utcDay(now.getTime() - MAX_DAYS_BACK * DAY_MS).slice(0, 7);
  const codes: Record<string, string> = {};
  for (const [m, c] of Object.entries(stored)) if (m >= oldest && typeof c === "string" && /^[0-9a-f]{32}$/.test(c)) codes[m] = c;
  const month = day.slice(0, 7);
  const code = (codes[month] ??= [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const since = typeof file.since === "string" ? file.since : utcDay(now.getTime());
  writeFileSync(codePath(), JSON.stringify({ codes, since }));
  return { code, since };
}

export function forgetCode(): void {
  rmSync(codePath(), { force: true });
}

export function readSentLog(limit = 30): string[] {
  try {
    return readFileSync(sentPath(), "utf8").split("\n").filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

function sentDays(): Set<string> {
  const out = new Set<string>();
  for (const line of readSentLog(10_000)) {
    try { out.add((JSON.parse(line) as { day: string }).day); } catch { /* skip */ }
  }
  return out;
}

/** Completed UTC days from max(since, today-30) to yesterday, not yet sent, oldest first. */
export function pendingDays(now: Date, since: string, sent: Set<string>): string[] {
  const out: string[] = [];
  for (let back = MAX_DAYS_BACK; back >= 1; back--) {
    const d = utcDay(now.getTime() - back * DAY_MS);
    if (d >= since && !sent.has(d)) out.push(d);
  }
  return out;
}

export function buildPayload(db: Database, day: string, code: string, app: string, os: string): UsagePayload | null {
  const from = Date.parse(`${day}T00:00:00Z`);
  const groups = rollup(db, from, from + DAY_MS);
  return groups.length ? { v: 1, code, day, app, os, groups } : null;
}

/**
 * Send every pending day. Each payload is written to telemetry-sent.jsonl
 * BEFORE the request, so the log on the person's disk is never behind what
 * left. A failed request is not retried: the day is undercounted, never sent
 * twice. Returns how many days were sent.
 */
export async function sendPending(db: Database, opts: { now?: Date; fetchFn?: typeof fetch } = {}): Promise<number> {
  if (sharingSetting() !== true) return 0;
  const now = opts.now ?? new Date();
  const fetchFn = opts.fetchFn ?? fetch;
  const { since } = monthlyCode(now);
  let n = 0;
  for (const day of pendingDays(now, since, sentDays())) {
    // Checked again per day: a switch-off mid-run stops the rest.
    if (sharingSetting() !== true) break;
    const payload = buildPayload(db, day, monthlyCode(now, day).code, appVersion(), osLabel());
    if (!payload) continue;
    appendFileSync(sentPath(), JSON.stringify(payload) + "\n");
    try {
      await fetchFn(USAGE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      n++;
    } catch {
      // Offline: the day stays logged as attempted; the count is a floor.
    }
  }
  return n;
}

/** A minute after boot, then every 6 h. Timers are unref'd so they never keep the process alive. */
export function startUsageSender(db: Database): () => void {
  const tick = () => void sendPending(db).catch(() => {});
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, EVERY_MS);
  (first as { unref?: () => void }).unref?.();
  (every as { unref?: () => void }).unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
