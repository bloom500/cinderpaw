import { afterEach, describe, expect, test } from "bun:test";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { PhoneOffers, isYes } from "../src/core/phone-offers.ts";
import { runAgent, setReplyTail } from "../src/transports/connectors.ts";
import { createSuggestTaskTool, type TaskSuggestion } from "../src/tools/builtin/suggest-task.ts";

// End to end with a fake WhatsApp: the agent offers a task in the owner's chat,
// the reply goes out with the accept line, and the owner answers (spec 4.9).

const OWNER = "whatsapp:owner@s.whatsapp.net";
const STRANGER = "whatsapp:lead@s.whatsapp.net";

function setup() {
  let clock = new Date(2026, 10, 14, 15, 0).getTime();
  const sent: Array<[string, string]> = [];
  const created: Array<[TaskSuggestion, string]> = [];
  const router = new ChannelAskRouter();
  router.registerSender("whatsapp", async (sid, text) => { sent.push([sid, text]); });
  const offers = new PhoneOffers({
    isChat: (sid) => router.canHandle(sid),
    isOwner: (sid) => sid === OWNER,
    create: (card, sid) => { created.push([card, sid]); },
    now: () => clock,
  });
  setReplyTail((sid) => offers.tail(sid));
  router.setAnswers((sid, text) => {
    const confirm = offers.answer(sid, text);
    if (confirm) void router.notify(sid, confirm);
    return confirm !== null;
  });
  router.observe((sid, dir) => { if (dir === "out") offers.said(sid); });
  const tool = createSuggestTaskTool(undefined, () => new Date(clock), () => "whatsapp", (sid, card) => offers.offer(sid, card));
  const toolSaid: string[] = [];

  /** One agent turn in `sid` that calls suggest_task with `args`, then says `reply`. */
  async function turn(sid: string, args: Record<string, unknown> | null, reply = "Sure.") {
    const agent = {
      handle: async () => {
        if (args) toolSaid.push((await tool.execute(args, { sessionId: sid } as never)).content);
        return reply;
      },
    };
    return (await runAgent(agent as never, sid, "remind me", "m1")).reply;
  }
  const reminder = { title: "Call the bank", task: "Call the bank about the card.", kind: "reminder", repeat: "once", in_minutes: 60 };
  return { sent, created, router, turn, reminder, toolSaid, advance: (ms: number) => { clock += ms; } };
}

afterEach(() => setReplyTail(null));

describe("accepting a task from the phone", () => {
  test("the reply ends with how to accept, and the owner's yes creates it", async () => {
    const t = setup();
    const reply = await t.turn(OWNER, t.reminder);
    expect(reply.split("\n").at(-1)).toBe('"Call the bank", today at 16:00. Reply "yes" to turn it on.');
    expect(t.toolSaid[0]).not.toContain("Shown as a card");
    expect(t.router.handleInbound(OWNER, "Da!")).toBe(true); // no agent turn
    expect(t.created).toHaveLength(1);
    expect(t.created[0]![1]).toBe(OWNER);
    expect(t.sent.at(-1)![1]).toContain('Turned on: "Call the bank"');
  });

  test("a yes from someone who is not the owner creates nothing and goes to the agent", async () => {
    const t = setup();
    await t.turn(STRANGER, t.reminder);
    expect(t.router.handleInbound(STRANGER, "yes")).toBe(false);
    expect(t.created).toHaveLength(0);
  });

  test("a yes after 10 minutes creates nothing and goes to the agent", async () => {
    const t = setup();
    await t.turn(OWNER, t.reminder);
    t.advance(10 * 60_000 + 1);
    expect(t.router.handleInbound(OWNER, "yes")).toBe(false);
    expect(t.created).toHaveLength(0);
  });

  test("a yes after Cinderpaw said something else answers that, not the offer", async () => {
    const t = setup();
    await t.turn(OWNER, t.reminder);
    await t.router.notify(OWNER, "⏰ Water the plants"); // a task fired in between
    expect(t.router.handleInbound(OWNER, "yes")).toBe(false);
    const u = setup();
    await u.turn(OWNER, u.reminder);
    await u.turn(OWNER, null, "Want me to also email them?"); // a newer reply
    expect(u.router.handleInbound(OWNER, "yes")).toBe(false);
    expect([...t.created, ...u.created]).toHaveLength(0);
  });

  test("a task that runs the AI is never turned on from the phone", async () => {
    const t = setup();
    const reply = await t.turn(OWNER, { ...t.reminder, kind: "agent", title: "Weekly summary" });
    expect(reply).toContain("open Cinderpaw on your computer");
    expect(reply).not.toContain('Reply "yes"');
    expect(t.router.handleInbound(OWNER, "yes")).toBe(false);
    expect(t.created).toHaveLength(0);
  });

  test("any other text reaches the agent, and the offer is closed", async () => {
    const t = setup();
    await t.turn(OWNER, t.reminder);
    expect(t.router.handleInbound(OWNER, "make it 5pm")).toBe(false);
    expect(t.router.handleInbound(OWNER, "yes")).toBe(false);
    expect(t.created).toHaveLength(0);
  });

  test("on the desktop nothing changes: the card is drawn and no line is added", async () => {
    const t = setup();
    const reply = await t.turn("desktop-chat-1", t.reminder);
    expect(reply).toBe("Sure.");
    expect(t.toolSaid[0]).toContain("card");
  });

  test("yes-words: English and Romanian, exact, not inside a sentence", () => {
    expect(["yes", "Yes.", "OK", "da!", "👍"].every(isYes)).toBe(true);
    expect(["yes but at 5", "no", "da, dar mai tarziu", ""].some(isYes)).toBe(false);
  });
});
