/**
 * No model at all (smoke test, 7 Nov). A new install that skipped the brain
 * step sent its first message and saw "Made room in this chat" on an empty
 * chat: the transcript budget without a model is a 1K guess, so the first
 * message was "too long" and got summarised by a model that does not exist.
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
import { PLACEHOLDER_MODEL } from "../src/rsi/l1-config/passive-supervisor.ts";

const BUDGET = { perConversation: 5_000_000, perDay: 50_000_000, onExhausted: "stop" } as const;

describe("a first message with no model chosen", () => {
  it("is not shortened: there is nothing to make room for", async () => {
    const original = globalThis.fetch;
    // What the bundled engine answers when no model is loaded (api.rs no_model_response).
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ type: "model_not_ready", error: "no model selected" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const db = openDatabase(":memory:");
    try {
      const audit = new AuditLog(db.raw);
      const router = new InferenceRouter(
        { primary: { provider: "ollama", model: PLACEHOLDER_MODEL, baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
        audit.logger,
        db.raw,
      );
      const episodic = new EpisodicMemory(db.raw, audit.logger);
      const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
      const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
      const agent = new AgentLoop(router, registry, episodic, {}, recall);

      const events: Array<{ type: string; tool?: string }> = [];
      await agent.handle("s1", "Find the five best coffee machines. " + "context ".repeat(1500), "m1", (e) => events.push(e as never));
      expect(events.some((e) => e.tool === "context_compaction")).toBe(false);
      // The turn still ends, and says why.
      expect(events.some((e) => e.type === "done" || e.type === "error")).toBe(true);
    } finally {
      db.close();
      globalThis.fetch = original;
    }
  });
});
