/**
 * Steering (4 Nov, from the DeepSeek Harness comparison): a message typed while
 * a turn runs reaches the model at its next step, instead of waiting for the
 * reply to end. Arriving while it answers, it earns one more step in the same
 * reply. With nothing running, it is refused so the host sends it normally.
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
import type { Tool, ToolManifest, ToolResult } from "../src/types.ts";

const BUDGET = { perConversation: 500_000, perDay: 5_000_000, onExhausted: "stop" } as const;

function build(script: string[], onCall?: (n: number) => void) {
  const bodies: string[] = [];
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    onCall?.(bodies.length);
    const content = script[bodies.length - 1] ?? "done.";
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
  const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
  const agent = new AgentLoop(router, registry, episodic, {}, new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger)));
  return { agent, registry, db, bodies };
}

describe("steering", () => {
  it("reaches the model at its next step, and the reply says it arrived", async () => {
    const original = globalThis.fetch;
    try {
      let agentRef: AgentLoop | null = null;
      const slow: Tool = {
        manifest: { name: "look", description: "Looks.", permissions: [], networkAccess: false } as ToolManifest,
        parameters: {},
        async execute(): Promise<ToolResult> {
          // The person types while the tool runs.
          expect(agentRef!.steer("s1", "make it shorter")).toBe(true);
          return { ok: true, content: "seen" };
        },
      };
      const { agent, registry, db, bodies } = build([
        "<tool_call>\n" + JSON.stringify({ name: "look", args: {} }) + "\n</tool_call>",
        "Short version.",
      ]);
      agentRef = agent;
      registry.register(slow);
      const events: Array<{ type: string; texts?: string[] }> = [];
      await agent.handle("s1", "write me a long story", "m1", (e) => events.push(e as never));
      expect(bodies[1]).toContain("make it shorter");
      expect(events.find((e) => e.type === "steer_applied")?.texts).toEqual(["make it shorter"]);
      db.close();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("arriving while it answers, one more step takes it in, in the same reply", async () => {
    const original = globalThis.fetch;
    try {
      let agentRef: AgentLoop | null = null;
      const { agent, db, bodies } = build(["First answer.", "Second answer, shorter."], (n) => {
        if (n === 1) agentRef!.steer("s1", "in Romanian please");
      });
      agentRef = agent;
      const chunks: string[] = [];
      await agent.handle("s1", "hello", "m1", (e) => {
        const ev = e as { type: string; content?: string };
        if (ev.type === "chunk" && ev.content) chunks.push(ev.content);
      });
      expect(bodies.length).toBe(2);
      expect(bodies[1]).toContain("in Romanian please");
      expect(chunks.join("")).toContain("First answer.");
      expect(chunks.join("")).toContain("Second answer");
      db.close();
    } finally {
      globalThis.fetch = original;
    }
  });

  // Stop pressed while an addition waited: it went with that turn on screen, but
  // the engine kept it and slipped it into the next turn's second step.
  it("a turn that ends before reading it leaves nothing for the next turn", async () => {
    const original = globalThis.fetch;
    try {
      let agentRef: AgentLoop | null = null;
      const { agent, registry, db, bodies } = build(
        ["First answer.", "<tool_call>\n" + JSON.stringify({ name: "look", args: {} }) + "\n</tool_call>", "Done."],
        (n) => {
          if (n === 1) {
            agentRef!.steer("s1", "in Romanian please");
            agentRef!.stop("s1");
          }
        },
      );
      agentRef = agent;
      registry.register({
        manifest: { name: "look", description: "Looks.", permissions: [], networkAccess: false } as ToolManifest,
        parameters: {},
        async execute(): Promise<ToolResult> { return { ok: true, content: "seen" }; },
      });
      await agent.handle("s1", "hello", "m1", () => {});
      await agent.handle("s1", "next", "m2", () => {});
      expect(bodies.length).toBe(3);
      expect(bodies.slice(1).some((b) => b.includes("in Romanian please"))).toBe(false);
      db.close();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("with nothing running it is refused, so the host sends it as a message", () => {
    // build() swaps the global fetch; left swapped, every later file in the
    // same bun run got "done." back (artifact-preview failed in CI, 5 Nov).
    const original = globalThis.fetch;
    try {
      const { agent, db } = build([]);
      expect(agent.steer("idle", "hi")).toBe(false);
      db.close();
    } finally {
      globalThis.fetch = original;
    }
  });
});
