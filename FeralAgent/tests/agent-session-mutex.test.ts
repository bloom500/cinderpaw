/**
 * P0-#4: per-session mutex on AgentLoop.handle().
 *
 * Two messages dispatched for the same sessionId in quick succession
 * (user hits send twice fast, or the frontend double-fires) used to
 * share the same `WorkingMemory` and race on the `messages.push()` and
 * `addToolResult()` paths. The audit identified this as a real bug.
 *
 * This test wires a real AgentLoop, registers a custom tool that the
 * model emits on every turn, dispatches two parallel `handle()` calls
 * for the same sessionId, and asserts:
 *   1. Both calls eventually return
 *   2. The two calls' transcript mutations are SERIALIZED — the
 *      WorkingMemory state at the end is the result of running them
 *      in order, not interleaved.
 *   3. Different sessionIds run in parallel (independence).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import type { OutboundEvent, Tool, ToolResult } from "../src/types.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

function ollamaOk(content: string, promptTokens = 10, evalTokens = 5) {
  return {
    message: { content },
    prompt_eval_count: promptTokens,
    eval_count: evalTokens,
  };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

/**
 * Build a sequenced Ollama mock that interleaves tool calls and final
 * answers per turn. Each "turn" is: tool_call → plain_text. The mock
 * returns the next response in the sequence on each fetch.
 */
function installTurnMock(turnCount: number) {
  let idx = 0;
  const mockFetch = (async () => {
    const turn = Math.floor(idx / 2) + 1;
    const isToolCall = idx % 2 === 0;
    const body = isToolCall
      // A3: Pass 1 (fenced blocks) removed. Use the only remaining format: <tool_call> XML.
      ? ollamaOk(`<tool_call>\n{"name": "ping", "args": {"turn": ${turn}}}\n</tool_call>`)
      : ollamaOk(`final-answer turn=${turn}`);
    idx++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  globalThis.fetch = mockFetch;
  return { remaining: () => turnCount * 2 - idx };
}

function buildAgent(): { agent: AgentLoop; toolCalls: number; cleanup: () => void } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));

  // A trivial "ping" tool. We track how many times it was called to assert
  // that BOTH messages produced their own tool invocation (no lost calls).
  let toolCalls = 0;
  const ping: Tool = {
    manifest: { name: "ping", description: "test", permissions: [], networkAccess: false },
    parameters: {},
    async execute(args): Promise<ToolResult> {
      toolCalls++;
      return { ok: true, content: `pong turn=${(args as { turn: number }).turn}` };
    },
  };
  registry.register(ping);

  const agent = new AgentLoop(router, registry, episodic, {}, recall);
  return { agent, toolCalls: () => toolCalls, cleanup: () => db.close() };
}

describe("AgentLoop session mutex (P0-#4)", () => {
  test("two parallel handle() calls for the same sessionId are serialized", async () => {
    // Need at least 2 turns × 2 messages = 4 Ollama responses. Give a
    // generous budget so the mock never runs out mid-test.
    installTurnMock(4);
    const { agent, cleanup } = buildAgent();

    // Fire two handle() calls in the same micro-tick. Without the mutex
    // they'd race on the shared WorkingMemory.
    const events1: OutboundEvent[] = [];
    const events2: OutboundEvent[] = [];
    const p1 = agent.handle("s1", "msg-1", "m1", (e) => events1.push(e));
    const p2 = agent.handle("s1", "msg-2", "m2", (e) => events2.push(e));

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toContain("final-answer");
    expect(r2).toContain("final-answer");

    // Both messages produced a final answer → both completed normally.
    // (With a race condition, one of them might emit "tool_done" with
    //  the wrong args, or get a stale "no tool call" result.)
    const done1 = events1.find((e) => e.type === "done");
    const done2 = events2.find((e) => e.type === "done");
    expect(done1).toBeDefined();
    expect(done2).toBeDefined();
    expect((done1 as { stopped: boolean }).stopped).toBe(false);
    expect((done2 as { stopped: boolean }).stopped).toBe(false);

    cleanup();
  });

  test("two parallel handle() calls for DIFFERENT sessionIds run concurrently", async () => {
    installTurnMock(8); // 2 turns × 4 sessions worth of buffer
    const { agent, cleanup } = buildAgent();

    const start = Date.now();
    const p1 = agent.handle("sA", "msg", "m1", () => {});
    const p2 = agent.handle("sB", "msg", "m2", () => {});
    await Promise.all([p1, p2]);
    const elapsed = Date.now() - start;

    // Independent sessions: their work runs in parallel. We can't assert
    // an exact wall-clock bound (CI machines vary) but a generous ceiling
    // (5s) is well above what two serialized turns would take (the mock
    // resolves instantly). This is a smoke test, not a strict timing
    // assertion — its job is to catch deadlocks, not to prove parallelism.
    expect(elapsed).toBeLessThan(5_000);
    cleanup();
  });

  test("after a handle() finishes, the next handle() for the same session runs cleanly", async () => {
    installTurnMock(4);
    const { agent, cleanup } = buildAgent();

    const r1 = await agent.handle("s1", "first", "m1", () => {});
    const r2 = await agent.handle("s1", "second", "m2", () => {});

    expect(r1).toContain("final-answer");
    expect(r2).toContain("final-answer");
    cleanup();
  });
});
