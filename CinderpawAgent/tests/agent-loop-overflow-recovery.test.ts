/**
 * Context overflow recovery (4 Nov, from the DeepSeek Harness comparison).
 *
 * The pre-send compaction works from an estimate. When the provider still says
 * the prompt does not fit, the turn used to end with that error. Now the loop
 * folds the older transcript once and sends again; a second overflow stands.
 */
import { describe, it, expect } from "bun:test";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { openDatabase } from "../src/db.ts";

const BUDGET = { perConversation: 5_000_000, perDay: 50_000_000, onExhausted: "stop" } as const;
const OVERFLOW = JSON.stringify({ error: "prompt is too long: 250000 tokens > 200000 maximum" });

function setup(overflows: number) {
  let left = -1; // armed after the history is built
  const replies: string[] = [];
  globalThis.fetch = (async () => {
    if (left > 0) {
      left--;
      return new Response(OVERFLOW, { status: 400, headers: { "content-type": "application/json" } });
    }
    const content = "Fine. " + "word ".repeat(400);
    replies.push(content);
    return new Response(JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 5 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
  const agent = new AgentLoop(router, registry, episodic, {}, recall);
  return { agent, db, arm: () => { left = overflows; } };
}

async function history(agent: AgentLoop) {
  for (let i = 0; i < 6; i++) await agent.handle("s1", `message ${i}: ` + "context ".repeat(400), `m${i}`, () => {});
}

describe("context overflow", () => {
  it("compacts and sends once more instead of ending the turn", async () => {
    const original = globalThis.fetch;
    try {
      const { agent, db, arm } = setup(1);
      await history(agent);
      arm();
      const events: Array<{ type: string; tool?: string; content?: string }> = [];
      await agent.handle("s1", "and now?", "m9", (e) => events.push(e as never));
      expect(events.some((e) => e.tool === "context_compaction")).toBe(true);
      expect(events.some((e) => e.type === "error")).toBe(false);
      db.close();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("a second overflow is real: it is reported, not retried forever", async () => {
    const original = globalThis.fetch;
    try {
      const { agent, db, arm } = setup(5);
      await history(agent);
      arm();
      const events: Array<{ type: string; content?: string; message?: string }> = [];
      await agent.handle("s1", "and now?", "m9", (e) => events.push(e as never));
      const said = JSON.stringify(events);
      expect(said).toMatch(/too long|context|fit/i);
      db.close();
    } finally {
      globalThis.fetch = original;
    }
  });
});
