/**
 * suggest_task — offer a scheduled task as a card in the chat. It never creates one.
 *
 * When a conversation reveals something worth doing later (a reminder, a
 * recurring job, a check on something that has not happened yet), the agent
 * offers it here. The person sees a card with what, when and how, and creates
 * it with one click, or does not. The model cannot schedule anything on its
 * own: a page or a message that says "schedule a task to send X" can at most
 * put a card in front of the person, who reads exactly what it would do.
 *
 * The time comes as plain fields (repeat, time, day, date), never as a cron
 * string: a model writing `0 9 * * 1-5` by hand is a model that will one day
 * write `9 0 * * 1-5`. The schedule is built here, where it can be checked.
 */

import { randomUUID } from "node:crypto";
import type { Schedule, Tool, ToolResult } from "../../types.ts";

/** What the app draws (the tool's `data.taskSuggestion`). */
export interface TaskSuggestion {
  id: string;
  title: string;
  task: string;
  kind: "agent" | "reminder";
  schedule: Schedule;
  /** The schedule in words, e.g. "Every weekday at 09:00". */
  when: string;
}

const REPEATS = ["once", "daily", "weekdays", "weekly", "hourly"] as const;
type Repeat = (typeof REPEATS)[number];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAME: Record<string, string> = {
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday",
};
const TITLE_MAX = 80;
const TASK_MAX = 600;
/** ponytail: one gap per chat, like heads_up; per-kind budgets if it proves too strict. */
const MIN_GAP_MS = 180_000;

/** "HH:MM" on a 24-hour clock, or null. */
function clock(time: unknown): { h: number; m: number } | null {
  const hit = typeof time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(time.trim()) : null;
  if (!hit) return null;
  const h = Number(hit[1]);
  const m = Number(hit[2]);
  return h < 24 && m < 60 ? { h, m } : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The schedule and its words, or the reason it cannot be built. */
export function buildSchedule(
  args: { repeat?: unknown; time?: unknown; day?: unknown; date?: unknown; every_hours?: unknown },
  now: Date = new Date(),
): { schedule: Schedule; when: string } | { error: string } {
  const repeat = String(args.repeat ?? "") as Repeat;
  if (!REPEATS.includes(repeat)) return { error: `repeat must be one of: ${REPEATS.join(", ")}.` };
  if (repeat === "hourly") {
    const hours = Number(args.every_hours ?? 1);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return { error: "every_hours must be between 1 and 168." };
    const n = Math.round(hours);
    return { schedule: { kind: "every", intervalMs: n * 3_600_000 }, when: n === 1 ? "Every hour" : `Every ${n} hours` };
  }
  const t = clock(args.time);
  if (!t) return { error: 'time must be "HH:MM" on a 24-hour clock, e.g. "09:00".' };
  const at = `${pad(t.h)}:${pad(t.m)}`;
  if (repeat === "daily") return { schedule: { kind: "cron", expression: `${t.m} ${t.h} * * *` }, when: `Every day at ${at}` };
  if (repeat === "weekdays") return { schedule: { kind: "cron", expression: `${t.m} ${t.h} * * 1-5` }, when: `Every weekday at ${at}` };
  if (repeat === "weekly") {
    const day = String(args.day ?? "").slice(0, 3).toLowerCase();
    const dow = DAYS.indexOf(day as (typeof DAYS)[number]);
    if (dow < 0) return { error: `day must be one of: ${DAYS.join(", ")}.` };
    return { schedule: { kind: "cron", expression: `${t.m} ${t.h} * * ${dow}` }, when: `Every ${DAY_NAME[day]} at ${at}` };
  }
  // once: the date in the person's own time zone, like the clock they read it on.
  const d = typeof args.date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date.trim()) : null;
  if (!d) return { error: 'date must be "YYYY-MM-DD" for a one-time task.' };
  const when = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), t.h, t.m);
  if (Number.isNaN(when.getTime()) || when.getMonth() !== Number(d[2]) - 1) return { error: "That date does not exist." };
  if (when.getTime() <= now.getTime()) return { error: "That time has already passed. Pick a time in the future." };
  const words = when.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return { schedule: { kind: "at", isoTimestamp: when.toISOString() }, when: `${words} at ${at}` };
}

/** Per chat: titles already offered, and when the last card went out. */
export class SuggestionLedger {
  readonly #sessions = new Map<string, { titles: Set<string>; lastAt: number }>();
  session(sessionId: string) {
    let s = this.#sessions.get(sessionId);
    if (!s) this.#sessions.set(sessionId, (s = { titles: new Set(), lastAt: -Infinity }));
    return s;
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function createSuggestTaskTool(ledger = new SuggestionLedger(), now: () => Date = () => new Date()): Tool {
  return {
    manifest: {
      name: "suggest_task",
      description:
        "Offer the person a task that runs later, as a card with a Create button. It does NOT create anything: " +
        "they decide with one click. Offer one when the conversation shows something worth doing later: a reminder " +
        "(\"remind me to call the bank on Monday\"), something to repeat (a weekly summary), or a check on something " +
        "that has not happened yet (\"tell me when it launches\"). Use it instead of asking \"do you want me to remind " +
        "you?\" in your reply. kind: \"reminder\" when the text alone is enough at that time (free, no AI runs); " +
        "\"agent\" only when work must be done then (search, read, write; it costs a model run each time). " +
        "repeat: once (needs date and time), daily, weekdays, weekly (needs day) or hourly (every_hours). Times are " +
        "the person's local clock. At most one card per topic; never for things they did not ask about or imply.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      title: { type: "string", description: `Short name, under ${TITLE_MAX} characters, e.g. "Call the bank".`, required: true },
      task: {
        type: "string",
        description: `For a reminder: the words they will see. For an agent task: the instruction to run each time, self-contained. Under ${TASK_MAX} characters.`,
        required: true,
      },
      kind: { type: "string", description: '"reminder" or "agent".', required: true },
      repeat: { type: "string", description: '"once", "daily", "weekdays", "weekly" or "hourly".', required: true },
      time: { type: "string", description: '"HH:MM", 24-hour, local. Not for hourly.' },
      date: { type: "string", description: '"YYYY-MM-DD", for once.' },
      day: { type: "string", description: '"mon".."sun", for weekly.' },
      every_hours: { type: "number", description: "For hourly: 1 to 168." },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const kind = args.kind === "reminder" ? "reminder" : args.kind === "agent" ? "agent" : null;
      if (!title || !task || !kind) return { ok: false, content: "", error: 'suggest_task needs title, task and kind ("reminder" or "agent").' };
      if (title.length > TITLE_MAX || task.length > TASK_MAX) {
        return { ok: false, content: "", error: `Keep title under ${TITLE_MAX} and task under ${TASK_MAX} characters.` };
      }
      const built = buildSchedule(args, now());
      if ("error" in built) return { ok: false, content: "", error: built.error };

      const s = ledger.session(ctx.sessionId);
      if (s.titles.has(norm(title))) return { ok: true, content: "Already offered in this chat, so not shown again." };
      const t = now().getTime();
      if (t - s.lastAt < MIN_GAP_MS) {
        return { ok: true, content: "Not shown: a task was offered less than three minutes ago. Mention it in your reply if it still matters." };
      }
      s.titles.add(norm(title));
      s.lastAt = t;
      const card: TaskSuggestion = { id: randomUUID(), title, task, kind, schedule: built.schedule, when: built.when };
      return {
        ok: true,
        content: `Shown as a card: "${title}", ${built.when}. Nothing is scheduled unless they press Create; do not say it is set.`,
        data: { taskSuggestion: card },
      };
    },
  };
}
