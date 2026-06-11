import { describe, it, expect } from "bun:test";
import { isComplexTask, AgentLoop } from "../src/core/agent-loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { InferenceRouter } from "../src/sandbox/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import { openDatabase } from "../src/db.ts";
import type { Tool, ToolManifest, ToolResult, ToolContext } from "../src/types.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

function toolBlock(name: string, args: Record<string, unknown>): string {
  return "<tool_call>\n" + JSON.stringify({ name, args }) + "\n</tool_call>";
}

/** No-op tool that always returns "done". */
const noopTool: Tool = {
  manifest: {
    name: "noop",
    description: "Does nothing.",
    permissions: [],
    networkAccess: false,
  } as ToolManifest,
  parameters: {},
  async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    return { ok: true, content: "done" };
  },
};

/**
 * P7 fix: isComplexTask no longer keyword-matches. The only signal is
 * message length (> 60 words). These tests assert the new, conservative
 * contract — keywords must NOT flip short messages into deep mode.
 */
describe("isComplexTask", () => {
  it("short simple question → false", () => {
    expect(isComplexTask("What is the capital of France?")).toBe(false);
  });

  it("'research' keyword in a short message → false (P7: keywords ignored)", () => {
    expect(isComplexTask("research the history of neural networks")).toBe(false);
  });

  it("'analyze' in a short message → false (P7: keywords ignored)", () => {
    expect(isComplexTask("analyze this dataset for trends")).toBe(false);
  });

  it("'compare' in a short message → false (P7: keywords ignored)", () => {
    expect(isComplexTask("compare GPT-4 and Claude on reasoning tasks")).toBe(false);
  });

  it("'comprehensive overview' in a short message → false (P7: keywords ignored)", () => {
    expect(isComplexTask("give me a comprehensive overview of RLHF")).toBe(false);
  });

  it("'summarize' in a short message → false (P7: keywords ignored)", () => {
    expect(isComplexTask("summarize the key findings from these papers")).toBe(false);
  });

  it("'in-depth' in a short message → false (P7: keywords ignored)", () => {
    expect(isComplexTask("I need an in-depth look at transformer architecture")).toBe(false);
  });

  it("'audit' / 'report' / 'overview' / 'every' / 'multiple' — all false (P7)", () => {
    // The original finding named "audit" specifically. Other previously-flagged
    // words that were clearly too broad in real usage are also asserted here
    // so a future regression that re-adds the keyword list is caught.
    for (const sample of [
      "audit this report",
      "give me an overview",
      "find every bug",
      "compile multiple sources",
      "thorough investigation needed",
      "summary please",
      "deep dive on transformers",
    ]) {
      expect(isComplexTask(sample)).toBe(false);
    }
  });

  it("long message (> 60 words) → true (length signal still works)", () => {
    const long = "word ".repeat(61).trim();
    expect(isComplexTask(long)).toBe(true);
  });

  it("exactly 60 words → false (threshold is > 60)", () => {
    const exactly60 = "word ".repeat(60).trim();
    expect(isComplexTask(exactly60)).toBe(false);
  });

  it("case-insensitive: long message in uppercase is still complex", () => {
    const long = "WORD ".repeat(61).trim();
    expect(isComplexTask(long)).toBe(true);
  });

  it("empty / whitespace message → false", () => {
    expect(isComplexTask("")).toBe(false);
    expect(isComplexTask("   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adaptive loop: self-termination beyond old hard-cap
// ---------------------------------------------------------------------------

describe("adaptive loop: no hard-cap message when tool calls exceed old maxIterations", () => {
  it("does not return hard-cap message when model uses tools beyond old limit", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // The model calls 'noop' 12 times (exceeding the old maxIterations=10),
      // then returns a plain-text answer on the 13th inference call.
      let callIdx = 0;
      const TOOL_CALLS = 12;
      globalThis.fetch = (async () => {
        callIdx++;
        const content =
          callIdx <= TOOL_CALLS
            ? toolBlock("noop", {})
            : "Task complete.";
        return new Response(
          JSON.stringify({
            message: { content },
            prompt_eval_count: 10,
            eval_count: 5,
          }),
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
      registry.register(noopTool);

      const agent = new AgentLoop(router, registry, episodic, {}, recall);
      const result = await agent.handle("s1", "do a complex multi-step task", "m1", () => {});

      // Model produced a final answer after 12 tool calls — should pass through.
      expect(result).toBe("Task complete.");
      // Must NOT contain the old hard-cap error message.
      expect(result).not.toContain("maximum number of reasoning steps");
      // All 13 inference calls were made.
      expect(callIdx).toBe(TOOL_CALLS + 1);

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
