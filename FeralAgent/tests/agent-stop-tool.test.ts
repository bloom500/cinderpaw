/**
 * P0-#3 end-to-end: AgentLoop.stop() must abort an in-flight tool call,
 * not just the inference router. Before this change, `stop()` only
 * reached the LLM stream — a hung tool kept the agent loop blocked
 * until the user gave up.
 *
 * This test wires a real AgentLoop with a real registry, registers a
 * custom "hang" tool whose `execute` returns a never-resolving promise,
 * fires `agent.stop()` from inside the `tool_start` event, and asserts
 * that:
 *   1. `handle()` returns within a tight time bound (didn't hang)
 *   2. The `done` event carries `stopped: true`
 *   3. The tool's result was a structured cancellation/timeout, not a
 *      crash or undefined
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
import type { OutboundEvent, Tool, ToolManifest } from "../src/types.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

const ollamaOk = (content: string, promptTokens = 10, evalTokens = 5) => ({
  message: { content },
  prompt_eval_count: promptTokens,
  eval_count: evalTokens,
});

// A3: Pass 1 (fenced blocks) removed. Use the only remaining format: <tool_call> XML.
function toolBlock(name: string, args: Record<string, unknown>): string {
  return "<tool_call>\n" + JSON.stringify({ name, args }) + "\n</tool_call>";
}

function hangToolManifest(name: string): ToolManifest {
  return {
    name,
    description: "intentionally hung tool for P0-#3 test",
    permissions: [],
    networkAccess: false,
  };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

describe("AgentLoop.stop() reaches an in-flight tool (P0-#3)", () => {
  test("stop() mid-tool-call returns promptly with stopped:true", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // Mock Ollama: first response emits a tool call to "hang_tool";
      // second response (never reached) would be the final answer.
      let callIdx = 0;
      globalThis.fetch = (async () => {
        callIdx++;
        const body =
          callIdx === 1
            ? ollamaOk(toolBlock("hang_tool", { reason: "test" }))
            : ollamaOk("This final answer should not be reached.");
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

      // A tool whose execute() NEVER resolves — even when ctx.signal aborts.
      // This is the pathological case the P0-#3 race must rescue.
      const hangTool: Tool = {
        manifest: hangToolManifest("hang_tool"),
        parameters: {},
        async execute() {
          await new Promise<never>(() => {});
          // Unreachable.
          return { ok: true, content: "unreachable" };
        },
      };
      registry.register(hangTool);

      const agent = new AgentLoop(router, registry, episodic, {}, recall);

      const events: OutboundEvent[] = [];
      const start = Date.now();
      // As soon as the tool starts, fire stop(). The agent loop must
      // return promptly — within the per-tool timeout (60s default) or
      // sooner if the abort reaches the race first.
      const handlePromise = agent.handle("s1", "do the hang", "m1", (e) => {
        events.push(e);
        if (e.type === "tool_start") {
          // Fire stop() right away — the in-flight tool promise is the
          // only thing keeping handle() alive at this point.
          agent.stop("s1");
        }
      });

      // Hard wall-clock guard: if P0-#3 isn't actually wired, this
      // test will hang for 60s (the default tool timeout) and fail with
      // the bun:test 5s default — both are obvious signals.
      const timeoutPromise = new Promise<string>((resolve) =>
        setTimeout(() => resolve("__TIMEOUT__"), 5_000),
      );
      const result = await Promise.race([
        handlePromise.then((r) => `ok:${r.slice(0, 40)}`),
        timeoutPromise,
      ]);
      const elapsed = Date.now() - start;

      expect(result).not.toBe("__TIMEOUT__");
      expect(elapsed).toBeLessThan(2_000);

      // done event has stopped: true
      const done = [...events].reverse().find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done).toMatchObject({ type: "done", stopped: true });

      // The tool's tool_done event was emitted with a structured error
      // (cancelled or timeout) — NOT a crash, NOT undefined.
      const toolDone = events.find((e) => e.type === "tool_done" && e.tool === "hang_tool");
      expect(toolDone).toBeDefined();
      if (toolDone && toolDone.type === "tool_done") {
        const r = toolDone.result as { ok: boolean; error?: string; content?: string };
        expect(r.ok).toBe(false);
        expect(["cancelled", "timeout", "aborted"]).toContain(r.error);
        expect(r.content).toBeDefined();
      }

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
