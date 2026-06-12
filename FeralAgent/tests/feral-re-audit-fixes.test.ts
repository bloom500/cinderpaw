import { describe, it, expect } from "bun:test";
import { parseCombined, MemoryExtractor } from "../src/memory/extractor.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import { InferenceRouter } from "../src/sandbox/inference-router.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import type { Tool, ToolManifest, ToolContext, ChatMessage, OutboundEvent } from "../src/types.ts";

describe("P2: parseCombined", () => {
  it("parses well-formed output with === FACTS === and === OBSERVATION ===", () => {
    const raw = `
=== FACTS ===
name: John
role: admin

=== OBSERVATION ===
type: discovery
title: Loaded configuration
facts:
- read config file
concepts: config, tauri
`;
    const res = parseCombined(raw);
    expect(res.facts).toContain("name: John");
    expect(res.facts).toContain("role: admin");
    expect(res.observation).toContain("type: discovery");
    expect(res.observation).toContain("title: Loaded configuration");
  });

  it("handles case-insensitive headers and whitespace variations", () => {
    const raw = `
  ==  facts  ==
name: John

  ======  observation  ======
type: preference
`;
    const res = parseCombined(raw);
    expect(res.facts).toBe("name: John");
    expect(res.observation).toBe("type: preference");
  });

  it("falls back to keyword-based parsing when separators are missing", () => {
    const raw = `
facts: name: John
type: decision
title: Configured DB
`;
    const res = parseCombined(raw);
    expect(res.facts).toContain("facts: name: John");
    expect(res.observation).toContain("type: decision");
  });

  it("gracefully returns full content as facts if observation is missing", () => {
    const raw = "hello world no headers";
    const res = parseCombined(raw);
    expect(res.facts).toBe("hello world no headers");
    expect(res.observation).toBe("");
  });
});

describe("R3: Concurrency event context and abort controller", () => {
  it("does not overwrite/leak context of concurrent sessions when queued", async () => {
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      let callCount = 0;
      let resumeFirstCall: (() => void) | null = null;

      globalThis.fetch = (async () => {
        callCount++;
        // Wait on the first call to simulate long execution
        if (callCount === 1) {
          await new Promise<void>((resolve) => {
            resumeFirstCall = resolve;
          });
        }
        return new Response(
          JSON.stringify({
            message: { content: "answer" },
            prompt_eval_count: 10,
            eval_count: 5,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;

      const audit = new AuditLog(db.raw);
      const egress = new EgressProxy(audit.logger);
      
      let registeredListener: ((info: any) => void) | null = null;
      const mockRouter = {
        setBudgetWarningListener: (listener: any) => {
          registeredListener = listener;
        },
        complete: async () => {
          callCount++;
          if (callCount === 1) {
            await new Promise<void>((resolve) => {
              resumeFirstCall = resolve;
            });
          }
          return { content: "answer" };
        },
        evictSession: () => {},
      } as unknown as InferenceRouter;

      const episodic = new EpisodicMemory(db.raw, audit.logger);
      const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
      const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));

      const agent = new AgentLoop(mockRouter, registry, episodic, {}, recall);

      const eventsA: OutboundEvent[] = [];
      const eventsB: OutboundEvent[] = [];

      // Start call A (will block inside complete)
      const promiseA = agent.handle("session-1", "A", "msg-A", (ev) => {
        eventsA.push(ev);
      });

      // Start call B for same session (queued)
      const promiseB = agent.handle("session-1", "B", "msg-B", (ev) => {
        eventsB.push(ev);
      });

      // Yield to let A start running and reach complete()
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Trigger budget warning for session-1 while A is running.
      // Under the old bug, B's write before the lock would have overwritten the context map.
      // So the warning would route to B's emit sink (eventsB) instead of A's (eventsA).
      if (registeredListener) {
        (registeredListener as any)({
          sessionId: "session-1",
          kind: "conversation",
          usage: 45000,
          limit: 50000,
          percent: 90,
        });
      }

      // Resume A
      if (resumeFirstCall) {
        resumeFirstCall();
      }

      await promiseA;
      await promiseB;

      // Assert that warning event went to A, not B
      const warningInA = eventsA.some(ev => ev.type === "budget_warning");
      const warningInB = eventsB.some(ev => ev.type === "budget_warning");

      expect(warningInA).toBe(true);
      expect(warningInB).toBe(false);

    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });
});

describe("A6: Fallback retry exhaustion and argMap", () => {
  function makeRegistry(tools: Tool[]): { reg: ToolRegistry; close: () => void } {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const proc = new RealProcessSandbox(audit.logger);
    const reg = new ToolRegistry(egress, audit, proc);
    for (const t of tools) reg.register(t);
    return { reg, close: () => db.close() };
  }

  it("exhausts retries and then runs fallback with mapped arguments", async () => {
    let primaryAttempts = 0;
    let fallbackArgsReceived: Record<string, unknown> | null = null;

    const primary = {
      manifest: {
        name: "primary",
        description: "primary tool",
        permissions: [],
        networkAccess: false,
        retry: {
          attempts: 2,
          on: ["any" as const],
        },
        fallback: [
          {
            name: "fallback",
            argMap: (args: Record<string, unknown>) => ({
              mappedQuery: `mapped_${args.query}`,
            }),
          },
        ],
      },
      parameters: {},
      execute: async () => {
        primaryAttempts++;
        return { ok: false, content: "failed", error: "http_error" };
      },
    };

    const fallback = {
      manifest: {
        name: "fallback",
        description: "fallback tool",
        permissions: [],
        networkAccess: false,
      },
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        fallbackArgsReceived = args;
        return { ok: true, content: "fallback success" };
      },
    };

    const { reg, close } = makeRegistry([primary, fallback]);
    try {
      const res = await reg.call("primary", { query: "test" }, "session-1");
      expect(res.ok).toBe(true);
      expect(res.content).toBe("fallback success");
      // Total primary calls = 1 initial + 2 retries = 3
      expect(primaryAttempts).toBe(3);
      expect(fallbackArgsReceived).toEqual({ mappedQuery: "mapped_test" });
    } finally {
      close();
    }
  });
});

describe("P2: MemoryExtractor Scheduling and Gating", () => {
  it("queues and idle-schedules extractions", async () => {
    const db = openDatabase(":memory:");
    const semantic = new SemanticMemory(db.raw, () => {});
    const episodic = new EpisodicMemory(db.raw, () => {});
    
    // Mock router
    let completeCalled = 0;
    const mockRouter = {
      complete: async () => {
        completeCalled++;
        return { content: "=== FACTS ===\nname: Alice\n=== OBSERVATION ===\nSKIP" };
      },
      evictSession: () => {},
    } as unknown as InferenceRouter;

    const extractor = new MemoryExtractor(mockRouter, semantic, episodic, null);

    let isIdle = false;
    extractor.setIdleChecker(() => isIdle);

    const turns: ChatMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "I am Alice" },
      { role: "assistant", content: "Nice to meet you Alice" },
      { role: "user", content: "Help me" },
      { role: "assistant", content: "Sure" },
    ]; // 3 assistant turns

    // Start extraction while NOT idle
    extractor.extractAsync("session-1", turns);
    expect(completeCalled).toBe(0); // Queued, not executed because not idle

    // Set idle to true and run pending
    isIdle = true;
    await extractor.runPending();
    expect(completeCalled).toBe(1); // Executed now that it is idle
    expect(semantic.get("name")?.value).toBe("Alice");

    db.close();
  });

  it("gates extraction according to assistant turns", async () => {
    const db = openDatabase(":memory:");
    const semantic = new SemanticMemory(db.raw, () => {});
    const episodic = new EpisodicMemory(db.raw, () => {});
    
    let completeCalled = 0;
    const mockRouter = {
      complete: async () => {
        completeCalled++;
        return { content: "=== FACTS ===\n=== OBSERVATION ===\nSKIP" };
      },
      evictSession: () => {},
    } as unknown as InferenceRouter;

    const extractor = new MemoryExtractor(mockRouter, semantic, episodic, null);
    extractor.setIdleChecker(() => true);

    // extractAsync queues work and drains it asynchronously — give the
    // internal runPending loop time to settle before each assertion.
    const drain = async () => {
      await new Promise((r) => setTimeout(r, 10));
      await extractor.runPending();
    };

    const turns1: ChatMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]; // 1 assistant turn
    extractor.extractAsync("session-1", turns1);
    await drain();
    expect(completeCalled).toBe(1); // First assistant turn extracts (short chats must learn too)

    const turns2: ChatMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "A" },
      { role: "assistant", content: "B" },
    ]; // 2 assistant turns — between the turn-1 and %3 gates
    extractor.extractAsync("session-1", turns2);
    await drain();
    expect(completeCalled).toBe(1); // No extraction at 2 turns

    const turns3: ChatMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "A" },
      { role: "assistant", content: "B" },
      { role: "user", content: "C" },
      { role: "assistant", content: "D" },
    ]; // 3 assistant turns
    extractor.extractAsync("session-1", turns3);
    await drain();
    expect(completeCalled).toBe(2); // Fired because assistantTurns = 3 (multiple of 3)

    db.close();
  });
});
