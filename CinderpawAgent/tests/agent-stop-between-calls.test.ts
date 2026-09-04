/**
 * stop() must also stop a generation when nothing is abortable right now.
 *
 * `stop()` used to be purely edge-triggered: abort the router's in-flight
 * fetch, abort the in-flight tool. But the router deletes a session's
 * AbortController once its call settles, and the tool signal has nobody
 * observing it once the tool has returned. So a stop landing BETWEEN two
 * model calls — while a tool is finishing, or during the episodic/memory
 * writes that follow it — hit two no-ops, `ctx.stopped` stayed false, and
 * the loop went right on to make the next model call. That is the
 * intermittent "I pressed stop and it kept generating".
 *
 * The regression: fire stop() on `tool_done`, which is precisely that
 * window. The loop must not issue a second completion.
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
import type { OutboundEvent, Tool } from "../src/types.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

const ollamaOk = (content: string) => ({
  message: { content },
  prompt_eval_count: 10,
  eval_count: 5,
});

function toolBlock(name: string, args: Record<string, unknown>): string {
  return "<tool_call>\n" + JSON.stringify({ name, args }) + "\n</tool_call>";
}

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

describe("AgentLoop.stop() with nothing in flight", () => {
  test("stop() on tool_done prevents the next model call", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // Call 1 asks for the tool. Call 2 is the answer the user must never
      // get, because they stopped before it could be requested.
      let completions = 0;
      globalThis.fetch = (async () => {
        completions++;
        const body =
          completions === 1
            ? ollamaOk(toolBlock("quick_tool", {}))
            : ollamaOk("SECOND CALL — the stop was dropped.");
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

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

      // Resolves immediately: by the time stop() fires there is no in-flight
      // fetch and no in-flight tool — nothing for an edge-triggered abort to
      // land on.
      const quickTool: Tool = {
        manifest: {
          name: "quick_tool",
          description: "returns immediately",
          permissions: [],
          networkAccess: false,
        },
        parameters: {},
        async execute() {
          return { ok: true, content: "done" };
        },
      };
      registry.register(quickTool);

      const agent = new AgentLoop(router, registry, episodic, {}, recall);

      const events: OutboundEvent[] = [];
      const final = await agent.handle("s1", "use the tool", "m1", (e) => {
        events.push(e);
        if (e.type === "tool_done") agent.stop("s1");
      });

      // The whole point: the second completion must never be requested.
      expect(completions).toBe(1);
      expect(final).not.toContain("SECOND CALL");

      const done = [...events].reverse().find((e) => e.type === "done");
      expect(done).toMatchObject({ type: "done", stopped: true });

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
