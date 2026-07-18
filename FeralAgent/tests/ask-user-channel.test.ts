/**
 * ask_user over messaging channels — format/parse purity + router lifecycle.
 * The router is what makes ask_user WORK on Discord/Slack/WhatsApp (before
 * this, the question card went to the desktop and the chat user never saw it).
 */

import { describe, expect, it } from "bun:test";
import {
  ChannelAskRouter,
  formatQuestionsForChat,
  parseChannelAnswers,
} from "../src/core/ask-user-channel.ts";
import { AskUserBridgeImpl } from "../src/core/ask-user-bridge.ts";
import { AskUserTimeoutError } from "../src/types.ts";
import type { AskUserQuestion } from "../src/types.ts";

const DB: AskUserQuestion = {
  question: "Which database?",
  options: [
    { label: "Postgres", recommended: true },
    { label: "SQLite" },
  ],
};
const COLOR: AskUserQuestion = {
  question: "Which color?",
  options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
  multiSelect: true,
};

describe("formatQuestionsForChat", () => {
  it("renders numbered options with the recommended star", () => {
    const text = formatQuestionsForChat([DB]);
    expect(text).toContain("Which database?");
    expect(text).toContain("1) Postgres ⭐");
    expect(text).toContain("2) SQLite");
    expect(text).toContain("Reply with the option number");
  });

  it("numbers the questions when there are several", () => {
    const text = formatQuestionsForChat([DB, COLOR]);
    expect(text).toContain("1. Which database?");
    expect(text).toContain("2. Which color?");
    expect(text).toContain("comma-separated");
  });
});

describe("parseChannelAnswers", () => {
  it("numeric reply picks the option", () => {
    const [a] = parseChannelAnswers([DB], "2");
    expect(a!.selected).toEqual(["SQLite"]);
  });

  it("label reply matches case-insensitively", () => {
    const [a] = parseChannelAnswers([DB], "postgres");
    expect(a!.selected).toEqual(["Postgres"]);
  });

  it("free text becomes customText", () => {
    const [a] = parseChannelAnswers([DB], "use MariaDB please");
    expect(a!.selected).toEqual([]);
    expect(a!.customText).toBe("use MariaDB please");
  });

  it("multiSelect accepts several numbers, single-select keeps the first", () => {
    const [c] = parseChannelAnswers([COLOR], "1 3");
    expect(c!.selected).toEqual(["Red", "Green"]);
    const [d] = parseChannelAnswers([DB], "1 2");
    expect(d!.selected).toEqual(["Postgres"]);
  });

  it("comma-separated tokens map to questions; missing token falls back to recommended/first", () => {
    const [a, b] = parseChannelAnswers([DB, COLOR], "2");
    expect(a!.selected).toEqual(["SQLite"]);
    expect(b!.selected).toEqual(["Red"]); // no recommended → first
  });

  it("out-of-range number degrades to customText", () => {
    const [a] = parseChannelAnswers([DB], "9");
    expect(a!.selected).toEqual([]);
    expect(a!.customText).toBe("9");
  });
});

describe("ChannelAskRouter", () => {
  it("sends the question and resolves on the next inbound", async () => {
    const sent: string[] = [];
    const router = new ChannelAskRouter();
    router.registerSender("discord", async (_s, text) => {
      sent.push(text);
    });
    expect(router.canHandle("discord:123")).toBe(true);
    expect(router.canHandle("slack:123")).toBe(false);

    const p = router.ask([DB], "discord:123");
    await Bun.sleep(0); // let the send land
    expect(sent[0]).toContain("Which database?");
    expect(router.pendingCount).toBe(1);

    expect(router.handleInbound("discord:123", "1")).toBe(true);
    const answers = await p;
    expect(answers[0]!.selected).toEqual(["Postgres"]);
    expect(router.pendingCount).toBe(0);
    // A non-pending message is NOT swallowed.
    expect(router.handleInbound("discord:123", "hello")).toBe(false);
  });

  it("times out with AskUserTimeoutError (tool auto-resolve contract)", async () => {
    const router = new ChannelAskRouter(10);
    router.registerSender("discord", async () => {});
    const err = await router.ask([DB], "discord:1").catch((e: Error) => e);
    expect(err).toBeInstanceOf(AskUserTimeoutError);
    expect(router.pendingCount).toBe(0);
  });

  it("a second ask in the same chat supersedes the first", async () => {
    const router = new ChannelAskRouter();
    router.registerSender("discord", async () => {});
    // Handlers attached at creation — a rejection with no handler yet is an
    // unhandled-rejection window (and wedges the bun runner on Windows).
    const first = router.ask([DB], "discord:1").catch((e: Error) => e);
    const second = router.ask([COLOR], "discord:1");
    expect(String(await first)).toContain("superseded");
    router.handleInbound("discord:1", "2");
    const answers = await second;
    expect(answers[0]!.selected).toEqual(["Blue"]);
  });

  it("unregisterSender cancels that connector's pending asks", async () => {
    const router = new ChannelAskRouter();
    router.registerSender("discord", async () => {});
    const p = router.ask([DB], "discord:1").catch((e: Error) => e);
    router.unregisterSender("discord");
    expect(String(await p)).toContain("connector stopped");
    expect(router.canHandle("discord:1")).toBe(false);
  });
});

describe("AskUserBridge delegate", () => {
  it("routes connector sessions to the delegate and desktop sessions to the event", async () => {
    const events: string[] = [];
    const bridge = new AskUserBridgeImpl((e) => events.push(e.type), { timeoutMs: 50 });
    const router = new ChannelAskRouter();
    router.registerSender("discord", async () => {});
    bridge.setDelegate(router);

    const p = bridge.ask([DB], "discord:9");
    await Bun.sleep(0);
    expect(events).toEqual([]); // no desktop event for a channel session
    router.handleInbound("discord:9", "1");
    expect((await p)[0]!.selected).toEqual(["Postgres"]);

    // Desktop session still emits the ask_user event.
    const desktop = bridge.ask([DB], "default").catch((e: Error) => e);
    await Bun.sleep(0);
    expect(events).toContain("ask_user");
    expect(await desktop).toBeInstanceOf(AskUserTimeoutError);
  });
});
