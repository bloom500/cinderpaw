/**
 * Error recovery / no-progress detection in the agent loop.
 *
 * The reference behaviour (Claude Code): read the error, adjust, retry at
 * most once, then tell the user what failed. The failure mode this guards
 * against is the two-cycle — the model alternates between two calls that
 * both fail, so no call ever equals its immediate predecessor and a
 * consecutive-run detector never fires. The loop then burns every
 * iteration it has.
 *
 * Both nudges are observed the way the model sees them: as messages in the
 * next outbound completion request.
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
import type { Tool, ToolManifest, ToolResult, ToolContext } from "../src/types.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

function toolBlock(name: string, args: Record<string, unknown>): string {
  return "<tool_call>\n" + JSON.stringify({ name, args }) + "\n</tool_call>";
}

/** Always fails, with a realistic error the model is meant to read. */
const flakyTool: Tool = {
  manifest: {
    name: "flaky",
    description: "Fails every time.",
    permissions: [],
    networkAccess: false,
  } as ToolManifest,
  parameters: { p: { type: "number", description: "which path" } },
  async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    return { ok: false, content: "ENOENT: no such file or directory", error: "not_found" };
  },
};

describe("no-progress detection", () => {
  it("catches an A,B,A,B two-cycle and quotes the error back at the model", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // A,B,A,B,A then a final answer. No call equals its predecessor, so the
      // old consecutive-run check produced no nudge at all.
      const script = [
        toolBlock("flaky", { p: 1 }),
        toolBlock("flaky", { p: 2 }),
        toolBlock("flaky", { p: 1 }),
        toolBlock("flaky", { p: 2 }),
        toolBlock("flaky", { p: 1 }),
        "I could not read that file.",
      ];
      let callIdx = 0;
      const sentBodies: string[] = [];
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        sentBodies.push(String(init?.body ?? ""));
        const content = script[callIdx] ?? "done.";
        callIdx++;
        return new Response(
          JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 5 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
      registry.register(flakyTool);

      const agent = new AgentLoop(router, registry, episodic, {}, recall);
      await agent.handle("s1", "read the config", "m1", () => {});

      const all = sentBodies.join("\n");
      // Second failure of the SAME arguments → corrected immediately, and the
      // correction carries the real error text so the model can act on it.
      expect(all).toContain("has now failed twice with these exact arguments");
      expect(all).toContain("ENOENT: no such file or directory");
      // Third appearance inside the window → looping.
      expect(all).toContain("you are looping");

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not nudge when calls differ and succeed", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const okTool: Tool = {
        manifest: { name: "fine", description: "Works.", permissions: [], networkAccess: false } as ToolManifest,
        parameters: { p: { type: "number", description: "n" } },
        async execute(): Promise<ToolResult> {
          return { ok: true, content: "ok" };
        },
      };
      const script = [
        toolBlock("fine", { p: 1 }),
        toolBlock("fine", { p: 2 }),
        toolBlock("fine", { p: 3 }),
        "Done.",
      ];
      let callIdx = 0;
      const sentBodies: string[] = [];
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        sentBodies.push(String(init?.body ?? ""));
        const content = script[callIdx] ?? "done.";
        callIdx++;
        return new Response(
          JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 5 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
      registry.register(okTool);

      const agent = new AgentLoop(router, registry, episodic, {}, recall);
      await agent.handle("s1", "do three things", "m1", () => {});

      const all = sentBodies.join("\n");
      expect(all).not.toContain("you are looping");
      expect(all).not.toContain("failed twice");

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
