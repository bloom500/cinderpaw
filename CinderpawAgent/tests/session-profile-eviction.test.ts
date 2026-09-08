/**
 * Session profile bindings survive eviction.
 *
 * `setSessionProfile` documents the binding as "sticky until cleared", but
 * both eviction paths (the LRU cap in `#memoryFor` and the TTL sweep in
 * `#evictIdleSessions`) deleted it together with the WorkingMemory. The
 * re-created session then answered as the owner: the full toolset
 * advertised, the owner system prompt, and its turns reported to the
 * user-turn observer (which feeds Memory Resume's "current task" - a
 * customer's message must never become that).
 *
 * Every connector transport re-binds the profile on each inbound message,
 * so this was latent on those surfaces. The loop still has to hold the
 * invariant for callers that bind once.
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
import { AgentLoop, type AgentLoopConfig } from "../src/core/agent-loop.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

/** Records every prompt (and the tool schemas) the "model" was sent. */
function installPromptRecorder(): { prompts: unknown[][]; tools: string[][] } {
  const prompts: unknown[][] = [];
  const tools: string[][] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: unknown[];
      tools?: { function?: { name?: string }; name?: string }[];
    };
    prompts.push(body.messages ?? []);
    tools.push((body.tools ?? []).map((t) => t.function?.name ?? t.name ?? "").filter(Boolean));
    return new Response(
      JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 1, eval_count: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };
  return { prompts, tools };
}

function buildRegistry(db: ReturnType<typeof openDatabase>): ToolRegistry {
  const audit = new AuditLog(db.raw);
  return new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
}

function buildAgent(
  db: ReturnType<typeof openDatabase>,
  config: Partial<AgentLoopConfig> = {},
  registry = buildRegistry(db),
): { agent: AgentLoop; registry: ToolRegistry } {
  const audit = new AuditLog(db.raw);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  return { agent: new AgentLoop(router, registry, episodic, config, recall), registry };
}

/** Stand-in for a tool that only exists on the restricted profile's allow-list. */
function namedTool(name: string) {
  return {
    manifest: { name, description: "test tool", permissions: [], networkAccess: false },
    parameters: {},
    async execute() { return { ok: true, content: `${name} ran` }; },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("profile binding survives session eviction", () => {
  test("LRU eviction keeps the allow-list, the persona prompt, and the observer quiet", async () => {
    const { prompts, tools } = installPromptRecorder();
    const db = openDatabase(":memory:");
    const { agent, registry } = buildAgent(db, { maxRetainedSessions: 2 });
    registry.register(namedTool("mcp_shop_lookup"));

    agent.registerProfile("public", {
      systemPrompt: "you are a shop bot",
      allowedTools: ["mcp_shop_lookup"],
    });
    // Bound ONCE, like a caller that binds at session creation. No re-bind
    // below: the binding itself must survive.
    agent.setSessionProfile("wa:cust", "public");

    const seen: string[] = [];
    agent.setUserTurnObserver((_s, text) => seen.push(text));

    // Positive controls: the owner advertises the drawer tool, the profiled
    // session advertises exactly its allow-list with its persona prompt.
    await agent.handle("owner:1", "hello", "o1", () => {});
    expect(tools.at(-1)).toContain("list_tools");
    await agent.handle("wa:cust", "do you sell shoes?", "m1", () => {});
    expect(tools.at(-1)).toContain("mcp_shop_lookup");
    expect(tools.at(-1)).not.toContain("list_tools");
    expect(JSON.stringify(prompts.at(-1))).toContain("shop bot");

    // Push wa:cust out through the LRU cap (2 entries: other:1, other:2).
    await agent.handle("other:1", "hi", "o2", () => {});
    await agent.handle("other:2", "hi", "o3", () => {});

    // The evicted session comes back. Still the shop bot, not the owner.
    await agent.handle("wa:cust", "and boots?", "m2", () => {});
    expect(tools.at(-1)).toContain("mcp_shop_lookup");
    expect(tools.at(-1)).not.toContain("list_tools");
    expect(JSON.stringify(prompts.at(-1))).toContain("shop bot");
    // The customer's turns never become the owner's "current task".
    expect(seen).toEqual(["hello", "hi", "hi"]);
    db.close();
  });

  test("TTL eviction keeps the allow-list", async () => {
    const { tools } = installPromptRecorder();
    const db = openDatabase(":memory:");
    const { agent, registry } = buildAgent(db, { sessionIdleEvictMs: 1 });
    registry.register(namedTool("mcp_shop_lookup"));

    agent.registerProfile("public", {
      systemPrompt: "you are a shop bot",
      allowedTools: ["mcp_shop_lookup"],
    });
    agent.setSessionProfile("wa:cust", "public");

    await agent.handle("wa:cust", "do you sell shoes?", "m1", () => {});
    expect(tools.at(-1)).toContain("mcp_shop_lookup");
    expect(tools.at(-1)).not.toContain("list_tools");

    // Go idle past the TTL so the next access sweeps the session.
    await sleep(15);
    await agent.handle("wa:cust", "and boots?", "m2", () => {});
    expect(tools.at(-1)).toContain("mcp_shop_lookup");
    expect(tools.at(-1)).not.toContain("list_tools");
    db.close();
  });
});
