/**
 * connectors_pair (spec 2026-09-24 §6.4-6.5): put the person on their own
 * bot's allowlist without them ever finding their user id.
 *
 * A freshly connected bot answers nobody: its allowlist is empty, and a
 * stranger's message is dropped with a log line only. Asking a beginner for
 * "your numeric Telegram user id" is where setup used to stop. Instead the
 * person messages the bot, this tool hears who it was, and asks on the page
 * "Is that you?". Yes puts that id on the allowlist.
 *
 * Proof before praise: after Yes it waits for the NEXT message from that id,
 * which now passes the gate. Only a result with `heard: true` lets the agent
 * say it works, because "it works" said over a bot that is still deaf is the
 * lie this whole slice exists to remove.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.ts";
import type { Sender } from "../../transports/connectors.ts";
import { PAIRABLE, allowSender, readRows } from "./connectors-manage.ts";

/** How long to wait for the person to message the bot, and again for the proof. */
const WAIT_MS = 10 * 60_000;
/** A message this recent still counts: the person may be quicker than the tool. */
const RECENT_MS = 5 * 60_000;

const YES = "Yes, that's me";
const NO = "No";

export interface PairDeps {
  isLive(id: string): boolean;
  allowlist(id: string): Promise<string[]>;
  allow(id: string, userId: string): Promise<void>;
  nextSender(
    id: string,
    match: (userId: string) => boolean,
    opts: { since: number; ms: number; signal?: AbortSignal },
  ): Promise<Sender | null>;
}

export function pairDepsFrom(manager: {
  healthOf(id: string): { live: boolean } | undefined;
  reload(): Promise<void>;
  nextSender: PairDeps["nextSender"];
}): PairDeps {
  return {
    isLive: (id) => manager.healthOf(id)?.live === true,
    allowlist: async (id) => (await readRows()).find((r) => r.id === id)?.allowlist ?? [],
    allow: async (id, userId) => {
      await allowSender(id, userId);
      await manager.reload();
    },
    nextSender: (id, match, opts) => manager.nextSender(id, match, opts),
  };
}

const say = (o: Record<string, unknown>): ToolResult => ({ ok: true, content: JSON.stringify(o) });

export function createConnectorsPairTool(deps: PairDeps): Tool {
  return {
    manifest: {
      name: "connectors_pair",
      description:
        "Let the person in on a connector you just brought online, without asking for their user id. " +
        "First tell them to send any message to the bot (a DM) now, then call this. It waits for that " +
        "message, asks them 'Is that you?', and on yes adds them to the allowlist. Then it waits for " +
        "one more message to prove they really get through. Say it works ONLY when the result has " +
        "heard: true. Works for " + Object.keys(PAIRABLE).join(", ") + ".",
      permissions: [],
      networkAccess: false,
      // Two waits on a person, up to ten minutes each. The card itself pauses the clock.
      timeoutMs: 2 * WAIT_MS + 60_000,
    },
    parameters: {
      id: { type: "string", description: "Connector id: " + Object.keys(PAIRABLE).join(", ") + ".", required: true },
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const id = String(args.id ?? "").trim().toLowerCase();
      const platform = PAIRABLE[id];
      if (!platform) {
        return {
          ok: false,
          content: `pairing_unsupported: '${id}' cannot hear who messaged it. Follow its steps to put the person's id on the allowlist.`,
        };
      }
      if (!ctx.askUser) {
        return { ok: false, content: "unsupported_surface: this chat cannot ask 'Is that you?'. Follow the connector's steps." };
      }
      if (!deps.isLive(id)) {
        return {
          ok: false,
          content: `not_connected: ${platform} is not online yet, so it cannot hear anyone. Finish connecting it first (connectors_manage list shows what is missing).`,
        };
      }

      // Seen live 25 Sep: the agent started this with "Let me fix that" and
      // nothing else, and the page sat on a silent spinner while the person had
      // no idea they were meant to act. Each wait says what it waits for, on the
      // page, whatever the model remembered to say.
      const waiting = (message: string) => ctx.progress?.({ stage: "waiting", progress: null, message });
      waiting(`Send your bot a direct message on ${platform} now. Any text works.`);

      const listed = new Set(await deps.allowlist(id));
      const declined = new Set<string>();
      const deadline = Date.now() + WAIT_MS;
      let since = Date.now() - RECENT_MS;
      let who: Sender | null = null;
      while (!who) {
        const s = await deps.nextSender(id, (u) => !listed.has(u) && !declined.has(u), {
          since,
          ms: Math.max(0, deadline - Date.now()),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (!s) {
          return say({
            paired: false,
            reason: "nobody_messaged",
            next: `Nobody new messaged me on ${platform} in 10 minutes. Ask them to send the bot a direct message, then call connectors_pair again.`,
          });
        }
        const named = s.name && s.name !== s.id ? s.name : "Someone";
        let answer: string | undefined;
        try {
          const [a] = await ctx.askUser.ask(
            [
              {
                question: `${named} just messaged me on ${platform}. Is that you?`,
                header: "Is that you?",
                options: [
                  { label: YES, description: `Then send me one more message on ${platform}, so we both know it works.` },
                  { label: NO, description: "I keep waiting for yours." },
                ],
                multiSelect: false,
              },
            ],
            ctx.sessionId,
          );
          answer = a?.selected?.[0];
        } catch {
          return say({ paired: false, reason: "person_declined", next: "The question was closed. Offer to try again when they are ready." });
        }
        if (answer === YES) who = s;
        else {
          declined.add(s.id);
          since = Date.now();
          waiting(`Still listening. Send your bot a direct message on ${platform}.`);
        }
      }

      const allowedAt = Date.now();
      await deps.allow(id, who.id);
      waiting(`You're in. Send your bot one more message on ${platform}, so we know it reaches me.`);
      const heard = await deps.nextSender(id, (u) => u === who.id, {
        since: allowedAt,
        ms: WAIT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!heard) {
        return say({
          paired: true,
          heard: false,
          name: who.name,
          next: `${who.name} is on the allowlist, but no message from them reached me after that. Do NOT say it works yet. Ask them to send one more message on ${platform}: when I answer them there, it works.`,
        });
      }
      return say({
        paired: true,
        heard: true,
        name: who.name,
        next: `It works: their message just reached me. Now say: "Good job, ${who.name}! I'll hear you out on ${platform} from now on."`,
      });
    },
  };
}
