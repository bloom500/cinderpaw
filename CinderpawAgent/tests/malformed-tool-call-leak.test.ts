/**
 * A model that will not stop emitting broken tool calls must not have them
 * delivered as the answer.
 *
 * Observed live on Discord (2026-08-05, MiniMax M3): after ~73 iterations of a
 * long task, the model emitted `{"name="read_file", …}` — an `=` where the
 * colon belongs — and kept doing it. `parseResponse` correctly recognised the
 * block as a malformed call, scrubbed it out of the visible text and asked for
 * a retry three times. Then the retries ran out, `parsed.text` was (correctly)
 * empty, and the loop's fallback took over:
 *
 *     const rawAnswer = stripThinking(parsed.text) || stripThinking(streamedSoFar);
 *
 * `streamedSoFar` is the RAW stream, tags and all. So the one path that exists
 * to rescue an answer from a stream the parser could not use handed the user
 * the exact machine syntax the parser had just removed. What arrived in the
 * chat was a `<tool_call>` block and nothing else.
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

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

/** The exact shape observed: a colon replaced by an equals sign. */
const BROKEN =
  '<tool_call>\n{"name="read_file","args":{"path":"D:\\CinderpawLocalAI\\a.ts"}}\n</tool_call>';

async function answerFor(script: string[]): Promise<string> {
  const originalFetch = globalThis.fetch;
  try {
    let i = 0;
    globalThis.fetch = (async () => {
      const content = script[Math.min(i++, script.length - 1)]!;
      return new Response(
        JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 5 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
    const agent = new AgentLoop(router, registry, episodic, {}, recall);
    return await agent.handle("s1", "read that file", "m1", () => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("a model stuck on invalid tool calls", () => {
  it("never delivers the raw block as the answer", async () => {
    // More attempts than MAX_MALFORMED_RETRIES, so the fallback is reached.
    const answer = await answerFor([BROKEN, BROKEN, BROKEN, BROKEN, BROKEN]);
    expect(answer).not.toContain("<tool_call>");
    expect(answer).not.toContain('"name=');
    expect(answer).not.toContain("read_file");
  });

  it("keeps the prose the model wrote around the broken call", async () => {
    const withProse = `Let me read that file for you.\n${BROKEN}`;
    const answer = await answerFor([withProse, withProse, withProse, withProse, withProse]);
    expect(answer).toContain("Let me read that file for you.");
    expect(answer).not.toContain("<tool_call>");
  });
});
