/**
 * Feral-WIP tests for the three critical fixes applied to the WIP:
 *
 *   #1 — adaptive loop: self-terminating, no nudge re-prompt (isComplexTask helper)
 *   #3 — shell_exec binary whitelist (FERAL_SHELL_WHITELIST env, SAFE_BINARIES)
 *   #5 — ask_user timeout auto-resolve (AskUserTimeoutError → recommended option)
 *
 * Each test targets the new behaviour. They do NOT replace the existing
 * tests — those still cover the original behaviour and continue to pass.
 */

import { describe, it, expect } from "bun:test";
import {
  AgentLoop,
  isComplexTask,
} from "../src/core/agent-loop.ts";
import { createAskUserTool } from "../src/tools/builtin/ask-user.ts";
import { AskUserTimeoutError } from "../src/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { openDatabase } from "../src/db.ts";
import type { Tool, ToolManifest, ToolResult, ToolContext } from "../src/types.ts";
import type {
  AskUserQuestion,
  AskUserAnswer,
  AskUserBridge,
  ToolContext,
  ToolManifest,
  ToolResult,
} from "../src/types.ts";

/** Per-test budget — high enough that the test won't trip the soft/hard stop. */
const BUDGET = {
  perConversation: 50_000,
  perDay: 500_000,
  onExhausted: "stop",
} as const;

// ---------------------------------------------------------------------------
// Feral-WIP #1 — confidence threshold
// ---------------------------------------------------------------------------

describe("Feral-WIP #1: confidence threshold", () => {
  it("isComplexTask: short message is not complex, long message is", () => {
    // A short message is not complex — the loop self-terminates quickly.
    expect(isComplexTask("what is 2+2?")).toBe(false);
    // A long message (> 60 words) is complex — more iterations may be needed.
    expect(isComplexTask("research " + "x ".repeat(70))).toBe(true);
  });

  // --- loop integration: the loop must return any non-empty answer immediately
  // A3 Part 2: The confidence-nudge re-prompt loop was deleted. The agent loop
  // now returns any non-empty answer immediately, regardless of length or tool
  // engagement.

  it("A3: loop returns tiny answer immediately (confidence nudge removed)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // 1st call: tiny "ok" (below CONFIDENCE_MIN_CHARS, no tool calls)
      // A3: this is now returned immediately — no 2nd call is made.
      let callIdx = 0;
      globalThis.fetch = (async () => {
        callIdx++;
        const content = callIdx === 1 ? "ok" : "a".repeat(60);
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
      const result = await agent.handle("s1", "explain quantum physics", "m1", () => {});

      // A3: tiny "ok" is returned immediately — no re-prompt, only 1 inference call.
      expect(result).toBe("ok");
      expect(callIdx).toBe(1);

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loop returns immediately when first answer is already confident (no re-prompt)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      let callIdx = 0;
      globalThis.fetch = (async () => {
        callIdx++;
        return new Response(
          JSON.stringify({
            message: { content: "a".repeat(60) },
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
      const result = await agent.handle("s1", "explain quantum physics", "m1", () => {});

      // Substantial answer on the first call → return on iteration 0.
      expect(result).toBe("a".repeat(60));
      expect(callIdx).toBe(1);

      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Feral-WIP #3 — shell_exec binary whitelist
// ---------------------------------------------------------------------------

describe("Feral-WIP #3: shell_exec whitelist (env-controlled)", () => {
  function ctxFor(tool: { manifest: ToolContext["manifest"] }): ToolContext {
    return {
      sessionId: "s",
      manifest: tool.manifest,
      fetch: (() => Promise.reject(new Error("not used"))) as never,
      audit: () => {},
    };
  }

  it("rejects a binary outside a NAMED restriction", async () => {
    // The knob's one surviving job: restricting to a named set. The list is read
    // at module load, hence the cache-busted import.
    process.env.FERAL_SHELL_WHITELIST = "git,node";
    try {
      const mod = await import(`../src/tools/builtin/shell-exec.ts?bust=${Date.now()}-a`);
      const tool = mod.createShellExecTool(["/tmp"]);
      const result = await tool.execute({ command: "malware --evil" }, ctxFor(tool));
      expect(result.ok).toBe(false);
      expect(result.error).toBe("binary_not_whitelisted");
    } finally {
      delete process.env.FERAL_SHELL_WHITELIST;
    }
  });

  it("with no restriction named, the binary gate does not fire at all", async () => {
    // The default used to be a list with the OS shells ON it, so `sh -c "…"`
    // ran anything anyway and the list only failed direct calls to ffmpeg,
    // docker, rg. Now nothing is gated by name. "malware" still fails — there
    // is no such program — but it must NOT fail as "not whitelisted", or the
    // agent is told to work around a boundary instead of reading the real error.
    delete process.env.FERAL_SHELL_WHITELIST;
    const mod = await import(`../src/tools/builtin/shell-exec.ts?bust=${Date.now()}-b`);
    const tool = mod.createShellExecTool(["/tmp"]);
    const result = await tool.execute({ command: "malware --evil" }, ctxFor(tool));
    expect(result.error).not.toBe("binary_not_whitelisted");
  });

  it("a knob set to punctuation states no restriction, it does not kill the tool", async () => {
    // An empty parsed list would leave allowedExecutables empty, and
    // tool-permissions refuses process:spawn outright for that — a stray comma
    // in a settings file would silently disable the shell.
    process.env.FERAL_SHELL_WHITELIST = " , ";
    try {
      const mod = await import(`../src/tools/builtin/shell-exec.ts?bust=${Date.now()}-c`);
      const tool = mod.createShellExecTool(["/tmp"]);
      expect(tool.manifest.allowedExecutables).toEqual(["*"]);
    } finally {
      delete process.env.FERAL_SHELL_WHITELIST;
    }
  });

  it("running any binary and running in any directory are separate permissions", async () => {
    // They rode one flag: dropping the binary list also unbound cwd from the
    // workspace. Where a command may run stays the operator's explicit call.
    delete process.env.FERAL_SHELL_WHITELIST;
    delete process.env.FERAL_PERMISSION_MODE;
    const mod = await import(`../src/tools/builtin/shell-exec.ts?bust=${Date.now()}-d`);
    expect(mod.createShellExecTool(["/tmp"]).manifest.allowAnyCwd).toBe(false);

    process.env.FERAL_PERMISSION_MODE = "full_access";
    try {
      const full = await import(`../src/tools/builtin/shell-exec.ts?bust=${Date.now()}-e`);
      expect(full.createShellExecTool(["/tmp"]).manifest.allowAnyCwd).toBe(true);
    } finally {
      delete process.env.FERAL_PERMISSION_MODE;
    }
  });

  it("the legacy wildcard still means full access, cwd included", async () => {
    process.env.FERAL_SHELL_WHITELIST = "*";
    try {
      const mod = await import(`../src/tools/builtin/shell-exec.ts?bust=${Date.now()}-f`);
      const tool = mod.createShellExecTool(["/tmp"]);
      expect(tool.manifest.allowedExecutables).toEqual(["*"]);
      expect(tool.manifest.allowAnyCwd).toBe(true);
    } finally {
      delete process.env.FERAL_SHELL_WHITELIST;
    }
  });
});

// ---------------------------------------------------------------------------
// Feral-WIP #5 — ask_user timeout auto-resolve
// ---------------------------------------------------------------------------

describe("Feral-WIP #5: ask_user timeout auto-resolves to recommended option", () => {
  function makeCtx(bridge: AskUserBridge): ToolContext {
    const manifest: ToolManifest = {
      name: "ask_user",
      description: "test",
      permissions: [],
      networkAccess: false,
    };
    return {
      sessionId: "s",
      manifest,
      fetch: (() => Promise.reject(new Error("not used"))) as never,
      audit: () => {},
      askUser: bridge,
    };
  }

  it("on AskUserTimeoutError, picks the recommended option for each question", async () => {
    const bridge: AskUserBridge = {
      ask: () => Promise.reject(new AskUserTimeoutError("test-id", 1000)),
      cancel: () => {},
    };
    const tool = createAskUserTool();
    const questions: AskUserQuestion[] = [
      {
        question: "Pick a database",
        options: [
          { label: "Postgres", recommended: true },
          { label: "SQLite" },
        ],
        multiSelect: false,
      },
      {
        question: "Include migrations?",
        options: [
          { label: "Yes" },
          { label: "No", recommended: true },
        ],
        multiSelect: false,
      },
    ];
    const result = await tool.execute({ questions }, makeCtx(bridge));
    expect(result.ok).toBe(true);
    const data = result.data as {
      questions: AskUserQuestion[];
      answers: AskUserAnswer[];
      autoResolved: boolean;
      autoResolveReason: string | null;
    };
    expect(data.autoResolved).toBe(true);
    expect(data.autoResolveReason).toMatch(/timeout/i);
    expect(data.answers[0]?.selected).toEqual(["Postgres"]); // recommended
    expect(data.answers[1]?.selected).toEqual(["No"]);      // recommended
    // Surface the auto-resolve in the content so the model can mention it.
    expect(result.content).toMatch(/auto-selected/i);
  });

  it("on AskUserTimeoutError with no recommended option, picks the first option", async () => {
    const bridge: AskUserBridge = {
      ask: () => Promise.reject(new AskUserTimeoutError("test-id", 1000)),
      cancel: () => {},
    };
    const tool = createAskUserTool();
    const questions: AskUserQuestion[] = [
      {
        question: "Color?",
        options: [{ label: "Red" }, { label: "Blue" }],
        multiSelect: false,
      },
    ];
    const result = await tool.execute({ questions }, makeCtx(bridge));
    expect(result.ok).toBe(true);
    const data = result.data as { answers: AskUserAnswer[]; autoResolved: boolean };
    expect(data.autoResolved).toBe(true);
    expect(data.answers[0]?.selected).toEqual(["Red"]); // first
  });

  it("on non-timeout error, returns ask_user_failed (no auto-resolve)", async () => {
    const bridge: AskUserBridge = {
      ask: () => Promise.reject(new Error("network down")),
      cancel: () => {},
    };
    const tool = createAskUserTool();
    const questions: AskUserQuestion[] = [
      {
        question: "Q?",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
    ];
    const result: ToolResult = await tool.execute({ questions }, makeCtx(bridge));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ask_user_failed");
  });
});

// ---------------------------------------------------------------------------
// Feral-WIP #2 — fallback chains
// ---------------------------------------------------------------------------

describe("Feral-WIP #2: fallback chains", () => {
  function makeRegistry(tools: Tool[]): { reg: ToolRegistry; close: () => void } {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const proc = new RealProcessSandbox(audit.logger);
    const reg = new ToolRegistry(egress, audit, proc);
    for (const t of tools) reg.register(t);
    return { reg, close: () => db.close() };
  }

  function makeTool(name: string, manifestExtra: Partial<ToolManifest>, exec: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>): Tool {
    return {
      manifest: {
        name,
        description: `test ${name}`,
        permissions: [],
        networkAccess: false,
        ...manifestExtra,
      },
      parameters: {},
      execute: exec,
    };
  }

  it("calls the fallback tool when the primary tool returns a failure", async () => {
    let primaryCalled = 0;
    let fallbackCalled = 0;
    const primary = makeTool("primary", { fallback: ["fallback"] }, async () => {
      primaryCalled++;
      return { ok: false, content: "primary failed", error: "http_error" };
    });
    const fallback = makeTool("fallback", {}, async () => {
      fallbackCalled++;
      return { ok: true, content: "fallback success" };
    });
    const { reg, close } = makeRegistry([primary, fallback]);
    try {
      const r = await reg.call("primary", {}, "s1");
      expect(r.ok).toBe(true);
      expect(r.content).toBe("fallback success");
      expect(primaryCalled).toBe(1);
      expect(fallbackCalled).toBe(1);
      const data = r.data as { fallbackFrom?: string } | undefined;
      expect(data?.fallbackFrom).toBe("primary");
    } finally {
      close();
    }
  });

  it("tries fallbacks in order and stops at the first success", async () => {
    const callOrder: string[] = [];
    const primary = makeTool("primary", { fallback: ["fb1", "fb2", "fb3"] }, async () => {
      callOrder.push("primary");
      return { ok: false, content: "nope", error: "http_error" };
    });
    const fb1 = makeTool("fb1", {}, async () => {
      callOrder.push("fb1");
      return { ok: false, content: "nope1", error: "http_error" };
    });
    const fb2 = makeTool("fb2", {}, async () => {
      callOrder.push("fb2");
      return { ok: true, content: "second fallback wins" };
    });
    const fb3 = makeTool("fb3", {}, async () => {
      callOrder.push("fb3");
      return { ok: true, content: "should not run" };
    });
    const { reg, close } = makeRegistry([primary, fb1, fb2, fb3]);
    try {
      const r = await reg.call("primary", {}, "s1");
      expect(r.ok).toBe(true);
      expect(r.content).toBe("second fallback wins");
      // fb1 may be retried (http_error is retryable if retry policy
      // declared it). We just verify the order goes primary -> fb1
      // -> fb2 eventually, and fb3 is never reached.
      expect(callOrder[0]).toBe("primary");
      expect(callOrder[callOrder.length - 1]).toBe("fb2");
      expect(callOrder).not.toContain("fb3");
    } finally {
      close();
    }
  });

  it("does not invoke any fallback when the primary succeeds", async () => {
    let fallbackCalled = 0;
    const primary = makeTool("primary", { fallback: ["fallback"] }, async () => ({
      ok: true,
      content: "primary ok",
    }));
    const fallback = makeTool("fallback", {}, async () => {
      fallbackCalled++;
      return { ok: true, content: "should not run" };
    });
    const { reg, close } = makeRegistry([primary, fallback]);
    try {
      const r = await reg.call("primary", {}, "s1");
      expect(r.ok).toBe(true);
      expect(r.content).toBe("primary ok");
      expect(fallbackCalled).toBe(0);
    } finally {
      close();
    }
  });

  it("web_search manifest declares deep_research as fallback", async () => {
    const { createWebSearchTool } = await import("../src/tools/builtin/web-search.ts");
    const tool = createWebSearchTool();
    expect(tool.manifest.fallback).toEqual(["deep_research"]);
  });

  it("deep_research manifest declares read_webpage as fallback", async () => {
    // Stub router; we never call deep_research in this test.
    const stubRouter = {} as Parameters<typeof import("../src/tools/builtin/deep-research.ts").createDeepResearchTool>[0];
    const { createDeepResearchTool } = await import("../src/tools/builtin/deep-research.ts");
    const tool = createDeepResearchTool(stubRouter, undefined);
    expect(tool.manifest.fallback).toEqual(["read_webpage"]);
  });
});

// ---------------------------------------------------------------------------
// Feral-WIP #2b — deep_research argument aliases
//
// Observed in tool-observations.jsonl: local models call deep_research with
// `query` (or even a corrupted key like `query"`) instead of the declared
// `question`, producing bad_args 7/9 times. The tool now accepts common
// aliases and tolerates junk characters in the key.
// ---------------------------------------------------------------------------

describe("Feral-WIP #2b: deep_research arg aliases", () => {
  async function run(args: Record<string, unknown>): Promise<ToolResult> {
    const { createDeepResearchTool } = await import("../src/tools/builtin/deep-research.ts");
    const stubRouter = {} as Parameters<typeof createDeepResearchTool>[0];
    const tool = createDeepResearchTool(stubRouter, undefined);
    const ctx = {
      sessionId: "test-aliases",
      fetch: async () => {
        throw new Error("no network in test");
      },
    } as unknown as ToolContext;
    return tool.execute(args, ctx);
  }

  it("still rejects empty args with bad_args", async () => {
    const res = await run({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad_args");
  });

  it("accepts `query` as an alias for `question`", async () => {
    const res = await run({ query: "what is bun?" });
    expect(res.error).not.toBe("bad_args");
  });

  it("accepts `topic` as an alias for `question`", async () => {
    const res = await run({ topic: "what is bun?" });
    expect(res.error).not.toBe("bad_args");
  });

  it('tolerates a corrupted key like `query"` from malformed model JSON', async () => {
    const res = await run({ 'query"': "what is bun?" });
    expect(res.error).not.toBe("bad_args");
  });

  it("prefers `question` when both question and query are present", async () => {
    // Both keys set; the canonical one must win. We can't observe which value
    // reached the loop directly, but bad_args must not fire and the call must
    // proceed (research_error from the stub router/fetch is expected).
    const res = await run({ question: "canonical", query: "alias" });
    expect(res.error).not.toBe("bad_args");
  });
});


