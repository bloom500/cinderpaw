/**
 * connectors_pair (spec 2026-09-24 §6.4-6.5): the person messages their new
 * bot, the page asks "Is that you?", and the agent may say it works only
 * after their next message really got through.
 */
import { afterAll, expect, test } from "bun:test";
import { ConnectorManager, type AgentLike } from "../src/transports/connectors.ts";
import { registerTransport, unregisterTransport, type ConnectorContext } from "../src/transports/registry.ts";
import { createConnectorsPairTool, type PairDeps } from "../src/tools/builtin/connectors-pair.ts";
import type { AskUserAnswer, AskUserQuestion, ToolContext } from "../src/types.ts";

// ── the manager hears senders ──────────────────────────────────────────────

afterAll(() => unregisterTransport("pairtest"));

async function managerWithFake(): Promise<{ mgr: ConnectorManager; say: (id: string, name: string) => void }> {
  let ctx: ConnectorContext | null = null;
  registerTransport("pairtest", () => ({
    async start(c) {
      ctx = c;
    },
    async stop() {},
    health: () => ({ live: true }),
    async send() {},
  }));
  const mgr = new ConnectorManager({ handleMessage: async () => "ok" } as unknown as AgentLike, () => {});
  await mgr.applyRows([{ id: "pairtest", enabled: true, secrets: {} }]);
  return { mgr, say: (id, name) => ctx!.onSender!(id, name) };
}

test("a waiter gets the next matching sender, not a non-matching one", async () => {
  const { mgr, say } = await managerWithFake();
  const next = mgr.nextSender("pairtest", (u) => u !== "owner", { since: Date.now(), ms: 1000 });
  say("owner", "Owner");
  say("42", "Ana");
  expect(await next).toEqual({ id: "42", name: "Ana" });
});

test("a message sent just before the wait still counts; an older one does not", async () => {
  const { mgr, say } = await managerWithFake();
  say("42", "Ana");
  expect(await mgr.nextSender("pairtest", () => true, { since: Date.now() - 1000, ms: 50 })).toEqual({ id: "42", name: "Ana" });
  expect(await mgr.nextSender("pairtest", () => true, { since: Date.now() + 1, ms: 50 })).toBeNull();
});

test("the wait ends with null when the call is stopped", async () => {
  const { mgr } = await managerWithFake();
  const stop = new AbortController();
  const next = mgr.nextSender("pairtest", () => true, { since: Date.now(), ms: 60_000, signal: stop.signal });
  stop.abort();
  expect(await next).toBeNull();
});

// ── the tool ───────────────────────────────────────────────────────────────

function ctxAnswering(answers: string[], asked: AskUserQuestion[][] = []): ToolContext {
  return {
    sessionId: "chat",
    askUser: {
      ask: async (qs: AskUserQuestion[]): Promise<AskUserAnswer[]> => {
        asked.push(qs);
        return [{ question: qs[0]!.question, selected: [answers.shift() ?? "No"] }];
      },
      cancel: () => {},
    },
  } as unknown as ToolContext;
}

/** Senders arrive in this order; each wait takes the first one it accepts. */
function fakeDeps(senders: Array<{ id: string; name: string }>, allowed: string[] = []): PairDeps & { allowed: string[] } {
  const queue = [...senders];
  return {
    allowed,
    isLive: () => true,
    allowlist: async () => [...allowed],
    allow: async (_id, userId) => {
      allowed.push(userId);
    },
    nextSender: async (_id, match) => {
      while (queue.length > 0) {
        const s = queue.shift()!;
        if (match(s.id)) return s;
      }
      return null;
    },
  };
}

test("Yes lets them in, and the praise waits for their next message", async () => {
  const asked: AskUserQuestion[][] = [];
  const deps = fakeDeps([{ id: "42", name: "Ana" }, { id: "42", name: "Ana" }]);
  const res = JSON.parse((await createConnectorsPairTool(deps).execute({ id: "discord" }, ctxAnswering(["Yes, that's me"], asked))).content);
  expect(asked[0]![0]!.question).toBe("Ana just messaged me on Discord. Is that you?");
  expect(deps.allowed).toEqual(["42"]);
  expect(res).toMatchObject({ paired: true, heard: true, name: "Ana" });
  expect(res.next).toContain("Good job, Ana!");
});

test("without the proof message there is no praise", async () => {
  const deps = fakeDeps([{ id: "42", name: "Ana" }]);
  const res = JSON.parse((await createConnectorsPairTool(deps).execute({ id: "telegram" }, ctxAnswering(["Yes, that's me"]))).content);
  expect(res).toMatchObject({ paired: true, heard: false });
  expect(res.next).toContain("Do NOT say it works");
  expect(res.next).not.toContain("Good job");
});

test("No keeps waiting, and the stranger is never let in", async () => {
  const deps = fakeDeps([{ id: "666", name: "Stranger" }, { id: "666", name: "Stranger" }, { id: "42", name: "Ana" }, { id: "42", name: "Ana" }]);
  const res = JSON.parse((await createConnectorsPairTool(deps).execute({ id: "discord" }, ctxAnswering(["No", "Yes, that's me"]))).content);
  expect(deps.allowed).toEqual(["42"]);
  expect(res).toMatchObject({ paired: true, heard: true, name: "Ana" });
});

test("someone already on the list is not asked about again", async () => {
  const asked: AskUserQuestion[][] = [];
  const deps = fakeDeps([{ id: "owner", name: "Owner" }], ["owner"]);
  const res = JSON.parse((await createConnectorsPairTool(deps).execute({ id: "discord" }, ctxAnswering([], asked))).content);
  expect(asked.length).toBe(0);
  expect(res).toMatchObject({ paired: false, reason: "nobody_messaged" });
});

test("it refuses what it cannot do, in words the agent can pass on", async () => {
  const tool = createConnectorsPairTool({ ...fakeDeps([]), isLive: () => false });
  expect((await tool.execute({ id: "sms" }, ctxAnswering([]))).content).toContain("pairing_unsupported");
  expect((await tool.execute({ id: "discord" }, { sessionId: "tui" } as unknown as ToolContext)).content).toContain("unsupported_surface");
  expect((await tool.execute({ id: "discord" }, ctxAnswering([]))).content).toContain("not_connected");
});

test("every wait tells the person, on the page, what to do", async () => {
  const said: string[] = [];
  const ctx = ctxAnswering(["Yes, that's me"]);
  (ctx as { progress?: unknown }).progress = (e: { message: string }) => said.push(e.message);
  await createConnectorsPairTool(fakeDeps([{ id: "42", name: "Ana" }, { id: "42", name: "Ana" }])).execute({ id: "discord" }, ctx);
  expect(said[0]).toContain("Send your bot a direct message on Discord");
  expect(said[1]).toContain("one more message");
});
