/**
 * heads_up — "Something you should know", without stopping the work.
 *
 * While a task runs, the agent can show the person a short card above their
 * message box: something it found that surprises, contradicts what they said
 * or assumed, or changes the plan. Unlike `ask_user` it does not wait; the
 * agent keeps working and the person answers when they like:
 *   Learn more         the card opens the longer explanation (`more`)
 *   I already knew this  the agent is told, so it stops flagging the obvious
 *   Dismiss            the card closes
 *
 * The card is drawn from this tool's `data`, like `show_widget`: the app never
 * parses the sentence the model reads.
 *
 * 24 Oct: it had never been shown (0 calls in 30 days). Its description said
 * "never for anything you will say in your reply anyway", and every real
 * finding ends up in the reply, so the model always waited for the reply. It
 * now says when: the moment it is found, before the task goes on.
 *
 * 31 Oct: still 1 call in 9,647 tool calls; Darius wants it about once every
 * one or two tasks, as cards come in Claude. It now also covers choices and
 * assumptions made for the person, and aims at about one per task. Still not
 * spam: the same title is never shown twice in a chat, and a second card
 * within two minutes is refused with "say it in your reply".
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolResult } from "../../types.ts";

export type HeadsUpChoice = "more" | "knew" | "dismiss";

/** What the app draws (the tool's `data.headsUp`). */
export interface HeadsUpCard {
  id: string;
  title: string;
  detail: string;
  more?: string;
}

const TITLE_MAX = 90;
const DETAIL_MAX = 400;
const MORE_MAX = 1500;
/** ponytail: one gap for every chat; per-task budgets if two minutes proves wrong. */
const MIN_GAP_MS = 120_000;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Per chat: what was shown, and what the person said they already knew. */
export class HeadsUpLedger {
  readonly #sessions = new Map<string, { titles: Map<string, string>; knew: string[]; lastAt: number }>();

  session(sessionId: string) {
    let s = this.#sessions.get(sessionId);
    if (!s) this.#sessions.set(sessionId, (s = { titles: new Map(), knew: [], lastAt: -Infinity }));
    return s;
  }

  /** Record the person's answer to card `id`; returns its title, or null for an unknown card. */
  answer(sessionId: string, id: string, choice: HeadsUpChoice): string | null {
    const s = this.#sessions.get(sessionId);
    const title = s?.titles.get(id) ?? null;
    if (s && title !== null && choice === "knew" && !s.knew.includes(title)) s.knew.push(title);
    return title;
  }
}

/** The process's one ledger: the tool writes it, dispatch records answers in it. */
export const headsUpLedger = new HeadsUpLedger();

const EXAMPLE =
  ' Example: {"title": "The invoice total does not match", "detail": "You said the total is 1,200 lei, but the PDF says 1,450 lei. I am using the PDF.", "more": "Page 2 lists an extra line ..."}';

export function createHeadsUpTool(ledger: HeadsUpLedger = headsUpLedger, now: () => number = Date.now): Tool {
  return {
    manifest: {
      name: "heads_up",
      description:
        "Show the person a short 'Something you should know' card NOW, while you keep working (it does not wait for an answer). " +
        "Call it the moment you find something that surprises, contradicts what they told you or assumed, or changes the " +
        "plan (a total that is not the number they gave, a file they named is missing, the data says the opposite of what " +
        "they expect, a step will cost money, two of their requests conflict), or when you decide something for them they " +
        "would want to know (which file, option, date or source you picked, an assumption you made, a limit you hit or worked " +
        "around), BEFORE you continue the task. Your reply only comes at the end; the card lets them react while you work, " +
        "so call it even if your reply will repeat it. Most tasks that do real work have one such moment: aim for about one " +
        "card per task. Never for progress updates or for something they told you themselves. title: one short line. detail: " +
        "one or two plain sentences, what you found or chose and what you are doing about it. more: optional, a few " +
        "sentences of evidence, shown if they tap Learn more.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      title: { type: "string", description: `One short line, under ${TITLE_MAX} characters.`, required: true },
      detail: { type: "string", description: `One or two plain sentences, under ${DETAIL_MAX} characters.`, required: true },
      more: { type: "string", description: `Optional: the evidence, under ${MORE_MAX} characters.` },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const detail = typeof args.detail === "string" ? args.detail.trim() : "";
      const more = typeof args.more === "string" && args.more.trim() ? args.more.trim().slice(0, MORE_MAX) : undefined;
      if (!title || !detail) return { ok: false, content: "", error: `heads_up needs a title and a detail.${EXAMPLE}` };
      if (title.length > TITLE_MAX || detail.length > DETAIL_MAX) {
        return { ok: false, content: "", error: `Keep the title under ${TITLE_MAX} and the detail under ${DETAIL_MAX} characters; put the rest in "more".${EXAMPLE}` };
      }

      const s = ledger.session(ctx.sessionId);
      const knew = s.knew.length
        ? ` They already knew: ${s.knew.slice(-3).join("; ")}. Flag only what is really new to them.`
        : "";
      if ([...s.titles.values()].some((t) => norm(t) === norm(title))) {
        return { ok: true, content: `Already shown in this chat, so not shown again.${knew}` };
      }
      const t = now();
      if (t - s.lastAt < MIN_GAP_MS) {
        return { ok: true, content: `Not shown: a heads-up went out less than two minutes ago. If this still matters, say it in your reply.${knew}` };
      }
      const card: HeadsUpCard = { id: randomUUID(), title, detail, ...(more ? { more } : {}) };
      s.titles.set(card.id, title);
      s.lastAt = t;
      return {
        ok: true,
        content: `Shown to the person as a card above their message box. Keep working; do not wait for an answer.${knew}`,
        data: { headsUp: card },
      };
    },
  };
}
