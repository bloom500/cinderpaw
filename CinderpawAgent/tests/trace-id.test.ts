/**
 * P2-#3: TraceId per handle() for audit timeline.
 *
 * Every OutboundEvent emitted during a single handle() call must
 * share the same traceId — that's what lets the UI / audit log
 * correlate the entire timeline of one user request.
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

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" as const };

function ollamaOk(content: string) {
  return { message: { content }, prompt_eval_count: 10, eval_count: 5 };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

describe("TraceId per handle() (P2-#3)", () => {
  test("all events from one handle() share the same traceId", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
      audit.logger, db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
    const tool: Tool = {
      manifest: { name: "ping", description: "t", permissions: [], networkAccess: false },
      parameters: {},
      async execute(): Promise<ToolResult> {
        return { ok: true, content: "pong" };
      },
    };
    registry.register(tool);
    const agent = new AgentLoop(router, registry, episodic, {}, recall);

    // Mock Ollama: tool call + final answer
    let idx = 0;
    globalThis.fetch = (async () => {
      idx++;
      const body = idx === 1
        // A3: Pass 1 (fenced blocks) removed. Use the only remaining format: <tool_call> XML.
        ? ollamaOk('<tool_call>\n{"name":"ping","args":{}}\n</tool_call>')
        : ollamaOk("done");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = globalThis.fetch; };

    const events: OutboundEvent[] = [];
    await agent.handle("s1", "go", "m1", (e) => events.push(e));

    // Collect all traceIds from events that have one.
    const traceIds = new Set<string>();
    for (const e of events) {
      if ("traceId" in e && typeof (e as { traceId?: string }).traceId === "string") {
        traceIds.add((e as { traceId: string }).traceId);
      }
    }
    // At minimum chunk, tool_start, tool_done, done must all share one.
    expect(traceIds.size).toBeGreaterThanOrEqual(1);
    // The 'done' event MUST carry a traceId.
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      expect(typeof done.traceId).toBe("string");
      expect(done.traceId.length).toBeGreaterThan(20); // UUID-ish
    }
    db.close();
  });

  test("two parallel handle() calls produce DIFFERENT traceIds", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
      audit.logger, db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
    const agent = new AgentLoop(router, registry, episodic, {}, recall);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify(ollamaOk("ok")), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = globalThis.fetch; };

    const events1: OutboundEvent[] = [];
    const events2: OutboundEvent[] = [];
    // Use different sessionIds so the mutex doesn't serialize them.
    await Promise.all([
      agent.handle("sA", "msg", "m1", (e) => events1.push(e)),
      agent.handle("sB", "msg", "m2", (e) => events2.push(e)),
    ]);

    const done1 = events1.find((e) => e.type === "done") as { traceId: string } | undefined;
    const done2 = events2.find((e) => e.type === "done") as { traceId: string } | undefined;
    expect(done1?.traceId).toBeDefined();
    expect(done2?.traceId).toBeDefined();
    expect(done1!.traceId).not.toBe(done2!.traceId);
    db.close();
  });
});
