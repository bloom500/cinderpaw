/**
 * Evicting a session's working memory must not evict its AUTHORIZATION.
 *
 * `#memoryFor` sweeps idle sessions before it looks one up, and the sweep
 * deleted `#sessionProfile` alongside the transcript. The transcript is a
 * cache; the profile binding is the answer to "is this person the owner".
 *
 * The sequence that fires it needs nothing unusual — a public lead on a
 * connector who goes quiet longer than `sessionIdleEvictMs` (30 minutes by
 * default) and then writes again:
 *
 *   1. the transport calls setSessionProfile() before the turn, as designed;
 *   2. handle() → #memoryFor() → the idle sweep sees this very session's old
 *      lastAccess and deletes both its memory AND the binding just written;
 *   3. #profileFor() returns null, so the turn runs as the OWNER — full
 *      toolset, owner system prompt.
 *
 * The stranger does not have to do anything clever. They have to wait.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import type { OutboundEvent, Tool, ToolResult } from "../src/types.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The model asks for `secret_tool` on turn 1, then answers plainly. */
function installMock() {
  let idx = 0;
  globalThis.fetch = (async () => {
    const body =
      idx++ % 2 === 0
        ? { message: { content: `<tool_call>\n{"name": "secret_tool", "args": {}}\n</tool_call>` } }
        : { message: { content: "done" } };
    return new Response(JSON.stringify({ ...body, prompt_eval_count: 1, eval_count: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function buildAgent(idleMs: number) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));

  let ran = 0;
  const secret: Tool = {
    manifest: { name: "secret_tool", description: "owner only", permissions: [], networkAccess: false },
    parameters: {},
    async execute(): Promise<ToolResult> {
      ran++;
      return { ok: true, content: "the owner's data" };
    },
  };
  registry.register(secret);

  const agent = new AgentLoop(router, registry, episodic, { sessionIdleEvictMs: idleMs });
  // A restricted profile: it may use nothing at all. This is the shape a
  // public lead runs under (PUBLIC_ALLOWED_TOOLS, minus everything).
  agent.registerProfile("public-lead", { systemPrompt: "You are a helper.", allowedTools: [] });
  return { agent, ranCount: () => ran, cleanup: () => db.close() };
}

/** Did the turn refuse the tool, or did it actually run it? */
function refused(events: OutboundEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === "tool_done" &&
      (e as { result?: { error?: string } }).result?.error === "not_available",
  );
}

describe("session eviction and the profile binding", () => {
  test("a restricted session stays restricted after its memory is evicted", async () => {
    installMock();
    // 1ms idle window: the second turn is always "long after" the first.
    const { agent, ranCount, cleanup } = buildAgent(1);
    const SID = "whatsapp:40712345678@s.whatsapp.net";

    const first: OutboundEvent[] = [];
    agent.setSessionProfile(SID, "public-lead");
    await agent.handle(SID, "hello", "m1", (e) => first.push(e));
    expect(refused(first)).toBe(true);
    expect(ranCount()).toBe(0);

    // The lead goes quiet past the idle window, then writes again. The
    // transport re-binds the profile before the turn, exactly as the
    // connectors do on every inbound message.
    await new Promise((r) => setTimeout(r, 20));
    const second: OutboundEvent[] = [];
    agent.setSessionProfile(SID, "public-lead");
    await agent.handle(SID, "still there?", "m2", (e) => second.push(e));

    // Before the fix this was false and the tool ran: the sweep deleted the
    // binding that had just been written, and the stranger got the owner.
    expect(refused(second)).toBe(true);
    expect(ranCount()).toBe(0);

    cleanup();
  });

  test("churning other sessions past the LRU cap does not free a lead's restrictions", async () => {
    installMock();
    const { agent, ranCount, cleanup } = buildAgent(60_000);
    const SID = "discord:chan:stranger";

    agent.setSessionProfile(SID, "public-lead");
    await agent.handle(SID, "hello", "m1", () => {});

    // Enough unrelated OWNER sessions to push the lead out of the LRU map.
    // These legitimately run the tool, so the lead's turn is measured as a
    // delta rather than against zero.
    for (let i = 0; i < 70; i++) {
      await agent.handle(`owner-session-${i}`, "hi", `x${i}`, () => {});
    }
    const ranBefore = ranCount();

    const back: OutboundEvent[] = [];
    agent.setSessionProfile(SID, "public-lead");
    await agent.handle(SID, "still there?", "m2", (e) => back.push(e));

    expect(refused(back)).toBe(true);
    expect(ranCount()).toBe(ranBefore);

    cleanup();
  });
});
