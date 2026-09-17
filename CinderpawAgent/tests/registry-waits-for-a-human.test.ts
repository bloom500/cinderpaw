/**
 * Time spent waiting for a person is not time a tool spent working.
 *
 * Every tool call is capped (60 s by default) so a hung fetch cannot hold the
 * loop. That cap also cut off every question: ask_user, the approval before a
 * file is sent, a computer_use confirmation. Someone reading three questions
 * for more than a minute lost them. The cap now pauses while the tool waits on
 * the person and resumes when they answer.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { AskUserAnswer, AskUserBridge, Tool } from "../src/types.ts";

function setup(answerAfterMs: number) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const bridge: AskUserBridge = {
    ask: (qs) =>
      new Promise<AskUserAnswer[]>((r) =>
        setTimeout(() => r([{ question: qs[0]!.question, selected: ["Yes"] }]), answerAfterMs),
      ),
    cancel: () => {},
  };
  const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger), undefined, bridge);
  return registry;
}

const asking = (workAfterMs = 0): Tool => ({
  manifest: { name: "asks_first", description: "asks, then works", permissions: [], networkAccess: false },
  parameters: {},
  async execute(_args, ctx) {
    const [a] = await ctx.askUser!.ask([{ question: "Go?", header: "Go", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] }], ctx.sessionId);
    await new Promise((r) => setTimeout(r, workAfterMs));
    return { ok: true, content: a!.selected[0]! };
  },
});

describe("the tool time limit and a person answering", () => {
  test("a person who takes longer than the limit to answer still gets their answer used", async () => {
    const registry = setup(150);
    registry.register(asking());
    const res = await registry.call("asks_first", {}, "s1", { timeoutMs: 50 });
    expect(res).toMatchObject({ ok: true, content: "Yes" });
  });

  test("the limit still applies to the work the tool does after the answer", async () => {
    const registry = setup(10);
    registry.register(asking(200));
    const res = await registry.call("asks_first", {}, "s1", { timeoutMs: 80 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timeout");
  });
});

describe("a question with no timeout set", () => {
  test("stays open until the person answers, and nothing is picked for them", async () => {
    const { AskUserBridgeImpl } = await import("../src/core/ask-user-bridge.ts");
    const events: string[] = [];
    const bridge = new AskUserBridgeImpl((e) => events.push(e.type));
    let settled = false;
    const answer = bridge.ask([{ question: "Q?", header: "Q", multiSelect: false, options: [{ label: "A", recommended: true }, { label: "B" }] }], "s1");
    void answer.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
    expect(events).toEqual(["ask_user"]);
  });

  test("in a chat app too", async () => {
    const { ChannelAskRouter } = await import("../src/core/ask-user-channel.ts");
    const router = new ChannelAskRouter();
    const sent: string[] = [];
    router.registerSender("telegram", async (_s, t) => {
      sent.push(t);
    });
    let settled = false;
    void router.ask([{ question: "Q?", header: "Q", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }], "telegram:1:2")
      .then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
    expect(router.handleInbound("telegram:1:2", "2")).toBe(true);
  });
});

describe("a tool's own time limit", () => {
  const slow = (manifestTimeout?: number): Tool => ({
    manifest: { name: "slow_tool", description: "sleeps", permissions: [], networkAccess: false, ...(manifestTimeout ? { timeoutMs: manifestTimeout } : {}) },
    parameters: {},
    async execute() {
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true, content: "done" };
    },
  });

  test("the registry reads the limit a tool declares", async () => {
    // deep_research was killed at the 60 s default on 17 Sep, mid-research, and
    // the agent fell back to reading raw HTML and wandered off the question.
    // A tool that runs long now says how long, and this is the reading of it.
    const registry = setup(0);
    registry.register(slow(50));
    expect(await registry.call("slow_tool", {}, "s1")).toMatchObject({ ok: false, error: "timeout" });
  });
});
