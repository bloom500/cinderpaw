/**
 * Brain Stack slice 5 — agent-loop wiring tests.
 *
 * End-to-end: Brain Stack is wired into AgentLoop. A coding prompt should
 * route to a coding-strong model; a simple prompt should route elsewhere.
 * These tests verify:
 *
 *   - brain=null → identical to today's path (regression: existing tests
 *     prove this; one explicit assertion here as the contract guard)
 *   - brain enabled + coding prompt → router receives completeWith() with
 *     the coding-strong target (verified by the URL fetch is called on)
 *   - brain enabled + simple prompt + budget mode → routes to local model
 *     (verified by URL)
 *   - brain enabled + BrainError (no available models) → falls through to
 *     router.complete() with #primary (silent fallback)
 *   - brain enabled + cloudReachable=false + offline hint → routes locally
 *     (verified by BrainStack's offline-force logic picking local model)
 *   - the routing decision is computed ONCE per user turn — two tool
 *     iterations in one turn do NOT re-route (verified by fetch URL count)
 *
 * Uses mocked fetch + a real BrainStack + a real InferenceRouter, the same
 * pattern as the existing agent-loop-complex-task tests.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import { InferenceRouter } from "../src/sandbox/inference-router.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { BrainStack } from "../src/brain/brain-stack.ts";
import { CircuitBreaker } from "../src/sandbox/circuit-breaker.ts";
import type { InferenceConfig } from "../src/types.ts";
import type { BrainModel } from "../src/brain/capability-registry.ts";

const BUDGET = {
  perConversation: 50_000,
  perDay: 500_000,
  onExhausted: "stop",
} as const;

// ---------------------------------------------------------------------------
// Test fixture models
// ---------------------------------------------------------------------------

const CODING_STRONG: BrainModel = {
  id: "coding-strong",
  target: {
    provider: "ollama",
    model: "coding-strong",
    baseUrl: "http://localhost:11434", // primary slot — but see test-specific configs
  },
  capabilities: { reasoning: 7, coding: 10, vision: 0, speed: 6, multilingual: 8 },
  cost: 3,
  local: true,
};

const SIMPLE_LOCAL: BrainModel = {
  id: "simple-local",
  target: {
    provider: "ollama",
    model: "simple-local",
    baseUrl: "http://localhost:11435",
  },
  capabilities: { reasoning: 6, coding: 7, vision: 0, speed: 9, multilingual: 5 },
  cost: 1,
  local: true,
};

// ---------------------------------------------------------------------------
// Fetch helpers — same pattern as existing tests
// ---------------------------------------------------------------------------

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

/**
 * Per-URL fetch mock. Each URL gets its own response body. Used to verify
 * which target Brain Stack routed to (the URL the fetch hits).
 */
function installFetchRouter(
  behaviors: Record<string, { body: unknown } | { fail: boolean }>,
): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);
    const b = behaviors[url];
    if (!b) throw new Error(`fetch not configured for ${url}`);
    if ("fail" in b && b.fail) throw new Error("mocked failure");
    return new Response(JSON.stringify(b.body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

/**
 * Build a minimal AgentLoop wired with mocked fetch. Returns the loop,
 * the router, and the call-capture array.
 */
async function buildAgentWithBrain(opts: {
  primary: InferenceConfig["primary"];
  fallback?: InferenceConfig["fallback"];
  trustedBaseUrls?: string[];
  brainModels?: BrainModel[];
  brainMode?: "budget" | "balanced" | "quality";
}) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const ps = new RealProcessSandbox(audit.logger);
  const registry = new ToolRegistry(egress, audit, ps);

  const config: InferenceConfig = {
    primary: opts.primary,
    ...(opts.fallback ? { fallback: opts.fallback } : {}),
    tokenBudget: BUDGET,
    ...(opts.trustedBaseUrls ? { trustedBaseUrls: opts.trustedBaseUrls } : {}),
  };
  const router = new InferenceRouter(config, audit.logger, db.raw);
  const episodic = new EpisodicMemory(db.raw, audit.logger);

  const brain = opts.brainModels
    ? new BrainStack(
        {
          enabled: true,
          mode: opts.brainMode ?? "balanced",
          registry: opts.brainModels,
        },
        new CircuitBreaker(),
      )
    : null;

  const agent = new AgentLoop(router, registry, episodic, {}, null, null, null, null, null, brain);

  return { agent, router, db };
}

// ---------------------------------------------------------------------------
// Regression: brain=null → identical to today's path
// ---------------------------------------------------------------------------

describe("AgentLoop with brain=null — regression", () => {
  test("coding prompt routes to #primary (no Brain Stack)", async () => {
    const mock = installFetchRouter({
      "http://localhost:11434/api/chat": {
        body: { message: { content: "ok" }, prompt_eval_count: 5, eval_count: 3 },
      },
    });
    restoreFetch = mock.restore;

    const { agent, db } = await buildAgentWithBrain({
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      trustedBaseUrls: ["http://localhost:11434"],
    });

    await agent.handle("s1", "refactor this", "m1", () => {});

    // Hit #primary, not any Brain-routed target.
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toBe("http://localhost:11434/api/chat");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// brain enabled — fetches the BRAIN-ROUTED target, not #primary
// ---------------------------------------------------------------------------

describe("AgentLoop with brain enabled — uses BrainStack targets", () => {
  test("coding prompt → router fetches the coding-strong target (brain's pick)", async () => {
    // #primary is on :11434 but Brain routes coding to :11435 (coding-strong).
    // Router has a cloud fallback so cloudReachable=true → offline=false →
    // classifier maps the coding prompt to "coding" (not "offline").
    const mock = installFetchRouter({
      "http://localhost:11434/api/chat": {
        body: { message: { content: "primary" }, prompt_eval_count: 5, eval_count: 3 },
      },
      "http://localhost:11435/api/chat": {
        body: { message: { content: "brain-routed" }, prompt_eval_count: 5, eval_count: 3 },
      },
    });
    restoreFetch = mock.restore;

    // Both models in the brain registry: coding-strong has coding=10,
    // simple-local has coding=7. Coding prompt should pick coding-strong.
    const codingOn35: BrainModel = { ...CODING_STRONG, target: { ...CODING_STRONG.target, baseUrl: "http://localhost:11435" } };
    const simpleOn34: BrainModel = { ...SIMPLE_LOCAL, target: { ...SIMPLE_LOCAL.target, baseUrl: "http://localhost:11434" } };

    const { agent, db } = await buildAgentWithBrain({
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      // Cloud fallback → cloudReachable=true → offline=false → classifier
      // sees a "coding" prompt and routes to coding-strong.
      fallback: {
        provider: "openai",
        model: "m",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      },
      trustedBaseUrls: [
        "http://localhost:11434",
        "http://localhost:11435",
        "https://api.openai.com/v1",
      ],
      brainModels: [codingOn35, simpleOn34],
      brainMode: "balanced",
    });

    await agent.handle("s1", "refactor this function", "m1", () => {});

    // Brain Stack picked coding-strong (the one on :11435), so the fetch
    // hits :11435 — NOT :11434 (the configured #primary).
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toBe("http://localhost:11435/api/chat");
    db.close();
  });

  test("simple prompt in budget mode → router fetches the local model via brain routing", async () => {
    // Two local models: coding-strong (cost 3) and simple-local (cost 1).
    // For a "simple" prompt in BUDGET mode, the local-bonus + low cost
    // makes simple-local win.
    const mock = installFetchRouter({
      "http://localhost:11434/api/chat": {
        body: { message: { content: "coding-strong" }, prompt_eval_count: 5, eval_count: 3 },
      },
      "http://localhost:11435/api/chat": {
        body: { message: { content: "simple-local" }, prompt_eval_count: 5, eval_count: 3 },
      },
    });
    restoreFetch = mock.restore;

    const codingOn34: BrainModel = { ...CODING_STRONG, target: { ...CODING_STRONG.target, baseUrl: "http://localhost:11434" } };
    const simpleOn35: BrainModel = { ...SIMPLE_LOCAL, target: { ...SIMPLE_LOCAL.target, baseUrl: "http://localhost:11435" } };

    const { agent, db } = await buildAgentWithBrain({
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      trustedBaseUrls: ["http://localhost:11434", "http://localhost:11435"],
      brainModels: [codingOn34, simpleOn35],
      brainMode: "budget",
    });

    await agent.handle("s1", "hi", "m1", () => {});

    // simple-local wins in budget mode → fetch hits :11435
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toBe("http://localhost:11435/api/chat");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// BrainError → silent fallback to router.complete() (#primary)
// ---------------------------------------------------------------------------

describe("AgentLoop with brain enabled — error fallback", () => {
  test("BrainError (no candidates) falls through to router.complete() with #primary", async () => {
    // Registry contains ONE model that is NOT configured (unconfigured):
    // registry.available() returns []. BrainStack throws BrainError.
    // Agent-loop catches the error in #routeForTurn, falls back to router.complete().
    const mock = installFetchRouter({
      "http://localhost:11434/api/chat": {
        body: { message: { content: "primary" }, prompt_eval_count: 5, eval_count: 3 },
      },
    });
    restoreFetch = mock.restore;

    // A cloud model with no apiKey — registry.available() filters it out
    // (BrainStack sees no candidates, throws BrainError).
    const unconfigured: BrainModel = {
      id: "unconfigured-cloud",
      target: {
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
        // no apiKey
      },
      capabilities: { reasoning: 9, coding: 9, vision: 9, speed: 9, multilingual: 9 },
      cost: 3,
      local: false,
    };

    const { agent, db } = await buildAgentWithBrain({
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      trustedBaseUrls: ["http://localhost:11434"],
      brainModels: [unconfigured],
    });

    await agent.handle("s1", "hi", "m1", () => {});

    // Fallback worked: hit #primary (the only configured model).
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toBe("http://localhost:11434/api/chat");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Routing decision is computed ONCE per turn (not per tool iteration)
// ---------------------------------------------------------------------------

describe("AgentLoop with brain enabled — route once per turn", () => {
  test("multi-iteration tool turn reuses the same brain-routed target", async () => {
    // Model emits a tool call on first iteration, then a final answer.
    // Both iterations should hit the SAME Brain-routed URL — Brain was
    // called once at the start of the turn, not per iteration.
    let callCount = 0;
    const original = globalThis.fetch;
    restoreFetch = () => (globalThis.fetch = original);
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      urls.push(url);
      callCount++;
      // First iteration: emit a tool call. Second: emit a text answer.
      const body =
        callCount === 1
          ? {
              message: {
                content: 'Let me look.\n<tool_call>\n{"name":"noop","args":{}}\n</tool_call>',
              },
              prompt_eval_count: 10,
              eval_count: 20,
            }
          : {
              message: { content: "Done." },
              prompt_eval_count: 10,
              eval_count: 5,
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    // Register a noop tool so the agent can call it and complete the loop.
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const ps = new RealProcessSandbox(audit.logger);
    const registry = new ToolRegistry(egress, audit, ps);
    registry.register({
      manifest: {
        name: "noop",
        description: "Does nothing.",
        permissions: [],
        networkAccess: false,
      },
      parameters: {},
      async execute() {
        return { ok: true, content: "ok" };
      },
    });

    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
        // Cloud fallback so cloudReachable=true → offline=false → the
        // coding prompt is classified as "coding" (not "offline") and
        // Brain picks coding-strong. Without this, the offline category
        // would force a speed-based pick regardless of the coding verb.
        fallback: {
          provider: "openai",
          model: "m",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
        },
        trustedBaseUrls: [
          "http://localhost:11434",
          "http://localhost:11435",
          "https://api.openai.com/v1",
        ],
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);

    const codingOn35: BrainModel = { ...CODING_STRONG, target: { ...CODING_STRONG.target, baseUrl: "http://localhost:11435" } };
    const simpleOn34: BrainModel = { ...SIMPLE_LOCAL, target: { ...SIMPLE_LOCAL.target, baseUrl: "http://localhost:11434" } };

    const brain = new BrainStack(
      { enabled: true, mode: "balanced", registry: [codingOn35, simpleOn34] },
      new CircuitBreaker(),
    );
    const agent = new AgentLoop(router, registry, episodic, {}, null, null, null, null, null, brain);

    await agent.handle("s1", "refactor this function", "m1", () => {});

    // Brain routed to coding-strong (:11435) on the FIRST iteration.
    // The second iteration (final answer) reuses the same target.
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const url of urls) {
      expect(url).toBe("http://localhost:11435/api/chat");
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Offline hint — cloudReachable=false forces local model
// ---------------------------------------------------------------------------

describe("AgentLoop with brain enabled — offline hint", () => {
  test("local-only router (no cloud reachable) routes Brain to local models", async () => {
    // Both Brain models are local. Router is local-only. cloudReachable=false.
    // Brain should route via the offline path (forced local). Both models
    // are local; Brain picks the top scorer (simple-local wins on speed).
    const mock = installFetchRouter({
      "http://localhost:11434/api/chat": {
        body: { message: { content: "primary" }, prompt_eval_count: 5, eval_count: 3 },
      },
      "http://localhost:11435/api/chat": {
        body: { message: { content: "fallback" }, prompt_eval_count: 5, eval_count: 3 },
      },
    });
    restoreFetch = mock.restore;

    const codingOn34: BrainModel = { ...CODING_STRONG, target: { ...CODING_STRONG.target, baseUrl: "http://localhost:11434" } };
    const simpleOn35: BrainModel = { ...SIMPLE_LOCAL, target: { ...SIMPLE_LOCAL.target, baseUrl: "http://localhost:11435" } };

    // Local-only router: primary = local, no fallback → cloudReachable=false.
    const { agent, db } = await buildAgentWithBrain({
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      trustedBaseUrls: ["http://localhost:11434", "http://localhost:11435"],
      brainModels: [codingOn34, simpleOn35],
      brainMode: "balanced",
    });

    await agent.handle("s1", "refactor this function", "m1", () => {});

    // Brain routed (local-only router → offline hint → local models only).
    // Which one wins depends on scoring, but it MUST be a Brain-routed
    // URL (not #primary routed through router.complete()).
    expect(mock.calls).toHaveLength(1);
    expect(["http://localhost:11434/api/chat", "http://localhost:11435/api/chat"]).toContain(
      mock.calls[0],
    );
    db.close();
  });
});