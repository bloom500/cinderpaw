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
import type { Schedule, Tool, ToolResult, WatchCondition } from "../../types.ts";
import { isBlockedHost } from "../../egress/egress-proxy.ts";

/** What the app draws (the tool's `data.taskSuggestion`). */
export interface TaskSuggestion {
  id: string;
  title: string;
  task: string;
  kind: "agent" | "reminder" | "watch";
  schedule: Schedule;
  /** The schedule in words, e.g. "Every weekday at 09:00". */
  when: string;
  watch?: WatchCondition;
  /** A price watch: the price the agent saw with its web tools in that turn, shown as seen by it (spec 4.10). */
  seenPrice?: number;
  expiryDays?: number;
  /** The person asked to get it on their phone: it goes there even while they are at the computer. */
  toPhone?: boolean;
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
  args: { repeat?: unknown; time?: unknown; day?: unknown; date?: unknown; every_hours?: unknown; in_minutes?: unknown },
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
  // "In 3 minutes", "in 2 hours": counted here. The agent ran a shell command
  // just to read the clock before it could offer one (24 Oct).
  if (repeat === "once" && args.in_minutes !== undefined && args.in_minutes !== null) {
    const mins = Number(args.in_minutes);
    // Down to 30 seconds: the scheduler looks every 30 s, so shorter would not be kept.
    if (!Number.isFinite(mins) || mins < 0.5 || mins > 60 * 24 * 365) return { error: "The shortest reminder is 30 seconds (in_minutes 0.5) and the longest a year. Tell the person this in plain words." };
    const at = new Date(now.getTime() + Math.round(mins * 60) * 1000);
    const same = at.toDateString() === now.toDateString();
    const words = same ? "Today" : at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    return { schedule: { kind: "at", isoTimestamp: at.toISOString() }, when: `${words} at ${pad(at.getHours())}:${pad(at.getMinutes())}` };
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
  readonly #sessions = new Map<string, { titles: Set<string>; lastAt: number; phoneOffered: boolean }>();
  session(sessionId: string) {
    let s = this.#sessions.get(sessionId);
    if (!s) this.#sessions.set(sessionId, (s = { titles: new Set(), lastAt: -Infinity, phoneOffered: false }));
    return s;
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * `phoneChannel`: the messenger a fired task reaches the person on, or null.
 * With none, the first card in a chat tells the agent to offer WhatsApp once
 * (28 Oct, Darius: the agent should offer it, and the code shows in the chat).
 */
export function createSuggestTaskTool(
  ledger = new SuggestionLedger(),
  now: () => Date = () => new Date(),
  phoneChannel: () => string | null = () => "unknown",
  /** In a chat app there is no card: true = kept as an offer the owner accepts with "yes" (core/phone-offers.ts). */
  offerInChat: (sessionId: string, card: TaskSuggestion) => boolean = () => false,
): Tool {
  return {
    manifest: {
      name: "suggest_task",
      description:
        "Offer the person a task that runs later, as a card with a Create button. It does NOT create anything: " +
        "they decide with one click. When they ask for something LATER or AGAIN (\"in 2 minutes\", \"tomorrow at 9\", " +
        "\"every Monday\", \"tell me when\"), do not do it now: call this, and only then answer in one line. " +
        "Also offer one when the conversation shows something worth doing later: a reminder " +
        "(\"remind me to call the bank on Monday\"), something to repeat (a weekly summary), or a check on something " +
        "that has not happened yet (\"tell me when it launches\"). Use it instead of asking \"do you want me to remind " +
        "you?\" in your reply. kind: \"reminder\" when the text alone is enough at that time (free, no AI runs); " +
        "\"agent\" only when work must be done then (search, read, write; it costs a model run each time). " +
        "repeat: once (date and time, or in_minutes for \"in 10 minutes\" / \"in 2 hours\"), daily, weekdays, weekly " +
        "(needs day) or hourly (every_hours). Times are " +
        "the person's local clock. At most one card per topic; never for things they did not ask about or imply. " +
        "When they want a product under a price (\"I want these headphones under 500 lei\"), find the product page " +
        "with your web tools in this turn, even with no link given, then offer kind \"watch\" with watch.priceBelow " +
        "(free, checked hourly, no AI runs) and watch.seenPrice set to the price you saw.",
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
      kind: { type: "string", description: '"reminder", "agent" or "watch". A watch checks a public HTTPS source for expected visible text, with no AI run.', required: true },
      repeat: { type: "string", description: '"once", "daily", "weekdays", "weekly" or "hourly".', required: true },
      time: { type: "string", description: '"HH:MM", 24-hour, local. Not for hourly.' },
      date: { type: "string", description: '"YYYY-MM-DD", for once.' },
      day: { type: "string", description: '"mon".."sun", for weekly.' },
      every_hours: { type: "number", description: "For hourly: 1 to 168." },
      in_minutes: { type: "number", description: "For once, instead of date and time: minutes from now (0.5 = in 30 seconds, 120 = in two hours)." },
      to_phone: { type: "boolean", description: "True when the person asks to get it on their phone (WhatsApp, Telegram...). It then goes there even while they are at the computer." },
      asked: { type: "boolean", description: "True when the person asked for this task in their own words. False (default) for a task you thought of yourself: those are offered at most once every three minutes." },
      watch: {
        type: "object", description: "For watch only: a public HTTPS source and EITHER concrete text whose appearance is the condition (contains) OR a price limit on a product page (priceBelow). Do not invent a condition or claim a source is official without evidence.",
        schema: { type: "object", properties: {
          sourceUrl: { type: "string", description: "Public HTTPS page to check. For a price: the product page itself, not a search or list." },
          contains: { type: "string", description: "Concrete expected visible text, not a model's opinion." },
          priceBelow: { type: "number", description: "Tell them when the page's price is under this number." },
          currency: { type: "string", description: "Three-letter code of that price, e.g. RON, EUR." },
          seenPrice: { type: "number", description: "With priceBelow: the price you saw on the page in this turn." },
          official: { type: "boolean", description: "True only with evidence this is the publisher's official source." },
        }, required: ["sourceUrl"], additionalProperties: false },
      },
      expiryDays: { type: "number", description: "Watch expiry, 1 to 365 days; default 30. Renewable by the person." },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const kind = args.kind === "reminder" ? "reminder" : args.kind === "agent" ? "agent" : args.kind === "watch" ? "watch" : null;
      if (!title || !task || !kind) return { ok: false, content: "", error: 'suggest_task needs title, task and kind ("reminder", "agent" or "watch").' };
      if (title.length > TITLE_MAX || task.length > TASK_MAX) {
        return { ok: false, content: "", error: `Keep title under ${TITLE_MAX} and task under ${TASK_MAX} characters.` };
      }
      const built = buildSchedule(args, now());
      if ("error" in built) return { ok: false, content: "", error: built.error };
      let watch: TaskSuggestion["watch"];
      let seenPrice: number | undefined;
      let expiryDays: number | undefined;
      if (kind === "watch") {
        const value = args.watch as Record<string, unknown> | undefined;
        const contains = typeof value?.contains === "string" ? value.contains.trim() : "";
        const priceBelow = typeof value?.priceBelow === "number" && Number.isFinite(value.priceBelow) && value.priceBelow > 0 ? value.priceBelow : null;
        const currency = typeof value?.currency === "string" ? value.currency.trim().toUpperCase() : "";
        let source: URL;
        try { source = new URL(typeof value?.sourceUrl === "string" ? value.sourceUrl : ""); }
        catch { return { ok: false, content: "", error: "watch.sourceUrl must be a public HTTPS URL." }; }
        // A proposal does not fetch. EgressProxy validates DNS and redirects
        // when the confirmed watch actually runs; a price is read once on accept.
        if (source.protocol !== "https:" || source.username || source.password || isBlockedHost(source.hostname)) {
          return { ok: false, content: "", error: "A watch needs a public HTTPS source without credentials." };
        }
        if (priceBelow === null && (!contains || contains.length > 500)) {
          return { ok: false, content: "", error: "A watch needs 1–500 characters of expected text, or priceBelow for a price." };
        }
        if (priceBelow !== null && currency && !/^[A-Z]{3}$/.test(currency)) {
          return { ok: false, content: "", error: "watch.currency must be a three-letter code, like RON or EUR." };
        }
        const days = args.expiryDays ?? 30;
        if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365 || built.schedule.kind === "at") {
          return { ok: false, content: "", error: "A watch needs a recurring schedule and expiryDays between 1 and 365." };
        }
        expiryDays = days;
        const official = typeof value?.official === "boolean" ? { official: value.official } : {};
        watch = priceBelow !== null
          ? { sourceUrl: source.toString(), priceBelow, ...(currency ? { currency } : {}), ...official }
          : { sourceUrl: source.toString(), contains, ...official };
        if (priceBelow !== null && typeof value?.seenPrice === "number" && Number.isFinite(value.seenPrice) && value.seenPrice > 0) seenPrice = value.seenPrice;
      }

      const s = ledger.session(ctx.sessionId);
      if (s.titles.has(norm(title))) return { ok: true, content: "Already offered in this chat, so not shown again.", data: { taskSuggestionStatus: "already_offered" } };
      const t = now().getTime();
      // The gap keeps the agent's own ideas from piling up; a person asking twice is not spam.
      if (args.asked !== true && t - s.lastAt < MIN_GAP_MS) {
        return { ok: true, content: "Not shown: a task was offered less than three minutes ago. Mention it in your reply if it still matters.", data: { taskSuggestionStatus: "rate_limited" } };
      }
      s.titles.add(norm(title));
      s.lastAt = t;
      const toPhone = args.to_phone === true;
      const card: TaskSuggestion = { id: randomUUID(), title, task, kind, schedule: built.schedule,
        when: toPhone ? `${built.when}, on your phone` : built.when,
        ...(watch ? { watch, expiryDays } : {}), ...(seenPrice !== undefined ? { seenPrice } : {}), ...(toPhone ? { toPhone } : {}) };
      if (offerInChat(ctx.sessionId, card)) {
        return {
          ok: true,
          // There is no card in a chat app; "see the card below" pointed at nothing (spec 4.9).
          content: `Offered: "${title}", ${built.when}. The app adds one line after your reply that says how to turn it on` +
            (kind === "agent" ? " (on their computer: it uses the AI each time)" : " (they reply \"yes\")") +
            ". In your reply, at most one short sentence about it. Do not mention a card, do not ask them to confirm, " +
            "do not say it is set, and do not end your reply with a question of your own.",
          data: { taskSuggestionStatus: "offered_in_chat" },
        };
      }
      // Away from the computer a task reaches nobody until a messenger is
      // connected. Offered once per chat, in one sentence, never pushed.
      const offerPhone = !s.phoneOffered && phoneChannel() === null;
      if (offerPhone) s.phoneOffered = true;
      return {
        ok: true,
        // One line is enough: the card says the rest (24 Oct: three sentences
        // explaining that nothing was set yet).
        content: `Shown as a card under your reply: "${title}", ${built.when}. It is created only when they press Create. In your reply, one short line pointing to the card; do not say it is set.` +
          (offerPhone
            ? " Their phone is not connected, so a task reaches them only in this app. Add one more sentence, in their language: " +
              "you can also send it to their WhatsApp, they only scan a code. If they agree, call connectors_manage to turn on " +
              "whatsapp: the code then appears right in this chat."
            : ""),
        data: { taskSuggestion: card },
      };
    },
  };
}
