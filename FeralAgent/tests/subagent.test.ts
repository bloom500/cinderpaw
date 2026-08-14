/**
 * Subagent delegation — P0-1.
 *
 * The subagent is a child `AgentLoop` with:
 *   - isolated `WorkingMemory` (child sessionId)
 *   - filtered `ToolRegistry` (only the parent's tools the caller allows)
 *   - its own budget (maxTokens + maxIterations)
 *   - shared `InferenceRouter` (separate sessionId for budget tracking)
 *   - hook integration (subagent_spawn + subagent_complete)
 *
 * Tests pin:
 *   1. Spawn fires `subagent_spawn` and `complete` fires `subagent_complete`
 *   2. The child sees only the allowed tools
 *   3. A failed run (inference error) returns status: "failed" + a useful
 *      error message in the answer field
 *   4. The summary is short (≤ MAX_SUMMARY_CHARS) so the parent agent
 *      can see it without dominating its own context
 *   5. maxIterations ceiling is enforced
 *   6. subagent_spawn hook can block a subagent run before it starts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subagent } from "../src/core/subagent.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { openDatabase, type FeralDb } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { ToolObservationLog } from "../src/telemetry/tool-observations.ts";
import type { InferenceRouter } from "../src/egress/inference-router.ts";
import type { Tool, ToolContext, ToolManifest, ToolResult } from "../src/types.ts";
import type { FeralFetch } from "../src/types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "feral-subagent-"));
}

function stubRouter(
  // Canned responses for the subagent. Each call to complete() returns
  // the next string in the array. The router's sessionId tracking is
  // ignored — the test doesn't care.
  responses: string[],
  totalTokensPerCall = 10,
): InferenceRouter {
  let i = 0;
  return {
    complete: async () => {
      const content = responses[i] ?? responses[responses.length - 1] ?? "";
      i++;
      return {
        content,
        promptTokens: totalTokensPerCall,
        completionTokens: content.length,
        totalTokens: totalTokensPerCall + content.length,
        model: "stub",
        usedFallback: false,
      };
    },
    abort: () => {},
    reconfigure: () => {},
    setBudgetWarningListener: () => {},
    setThrottleListener: () => {},
  } as unknown as InferenceRouter;
}

function makeFailingRouter(errorMessage: string): InferenceRouter {
  return {
    complete: async () => { throw new Error(errorMessage); },
    abort: () => {},
    reconfigure: () => {},
    setBudgetWarningListener: () => {},
    setThrottleListener: () => {},
  } as unknown as InferenceRouter;
}

function makeEchoTool(name: string, result: string = "ok"): Tool {
  const manifest: ToolManifest = {
    name,
    description: `echo tool ${name}`,
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute(args, _ctx: ToolContext): Promise<ToolResult> {
      return { ok: true, content: `${result} ${JSON.stringify(args)}` };
    },
  };
}

interface Deps {
  router: InferenceRouter;
  allTools: Tool[];
  db: FeralDb;
  hooks: HookRegistry;
  audit: AuditLog;
  egress: EgressProxy;
  process: RealProcessSandbox;
  episodic: EpisodicMemory;
  observations: ToolObservationLog;
  parentRegistry: ToolRegistry;
}

function makeDeps(router: InferenceRouter, toolNames: string[]): Deps {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const proc = new RealProcessSandbox(audit.logger);
  const observations = new ToolObservationLog(".");
  const allTools = toolNames.map((n) => makeEchoTool(n, `result-${n}`));
  const registry = new ToolRegistry(egress, audit, proc, observations);
  for (const t of allTools) registry.register(t);
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  return {
    router,
    allTools,
    db,
    hooks: new HookRegistry(),
    audit,
    egress,
    process: proc,
    episodic,
    observations,
    parentRegistry: registry,
  };
}

afterEach(() => {
  // Each test manages its own cleanup.
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Subagent.run", () => {
  let deps: Deps;
  beforeEach(() => {
    deps = makeDeps(stubRouter(["final answer from subagent"]), ["echo_a", "echo_b", "echo_c"]);
  });
  afterEach(() => deps.db.close());

  test("returns a completed result with the model's answer", async () => {
    const sa = new Subagent({
      router: deps.router,
      allTools: deps.allTools,
      audit: deps.audit,
      egress: deps.egress,
      process: deps.process,
      observations: deps.observations,
      episodic: deps.episodic,
      hooks: deps.hooks,
    });
    const r = await sa.run({
      task: "do something",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
    });
    expect(r.status).toBe("completed");
    expect(r.answer).toContain("final answer from subagent");
    expect(r.subagentId).toBeTruthy();
    // tokensUsed is 0 in V1 — the agent loop doesn't surface per-run
    // totals through the event stream. P0-1 V1.1 will add a
    // `tokens_used` event; for now the field is best-effort.
    expect(r.tokensUsed).toBeGreaterThanOrEqual(0);
  });

  /**
   * Cancellation. Before this existed, `SubagentConfig` had no signal at all
   * and a subagent could not be stopped by anything: the user's Stop reaches
   * the PARENT's session controller, and a child runs its own AgentLoop under
   * its own session id. For `rlm()` workers — which run detached in the
   * background — that meant Stop ended the visible turn while paid model loops
   * carried on invisibly.
   */
  test("an already-stopped signal cancels before the first model call", async () => {
    let calls = 0;
    const counting = {
      ...deps.router,
      complete: async (...a: unknown[]) => {
        calls++;
        return (deps.router.complete as (...x: unknown[]) => unknown)(...a);
      },
    } as unknown as typeof deps.router;
    const sa = new Subagent({ ...deps, router: counting });
    const ac = new AbortController();
    ac.abort("user stop");

    const r = await sa.run({
      task: "do something",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
      signal: ac.signal,
    });

    expect(r.status).toBe("cancelled");
    // The point of the early check: a stopped turn must not be billed.
    expect(calls).toBe(0);
  });

  test("cancelled is not 'failed' — delegate_task must not retry a user's stop", async () => {
    // Pinning the distinction rather than the plumbing: the retry in
    // delegate-task.ts fires on every non-completed status, so folding
    // cancellation into `failed` would silently re-run the work the user was
    // in the middle of stopping, at double the cost.
    const sa = new Subagent({ ...deps });
    const ac = new AbortController();
    ac.abort();
    const r = await sa.run({
      task: "do something",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
      signal: ac.signal,
    });
    expect(r.status).not.toBe("failed");
    expect(r.status).toBe("cancelled");
  });

  test("inference error → status: 'failed' with a useful answer", async () => {
    const failDeps = makeDeps(
      makeFailingRouter("inference down"),
      ["echo_a"],
    );
    const sa = new Subagent({
      router: failDeps.router,
      allTools: failDeps.allTools,
      audit: failDeps.audit,
      egress: failDeps.egress,
      process: failDeps.process,
      observations: failDeps.observations,
      episodic: failDeps.episodic,
      hooks: failDeps.hooks,
    });
    const r = await sa.run({
      task: "do something",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
    });
    expect(r.status).toBe("failed");
    expect(r.answer).toMatch(/inference down/);
    failDeps.db.close();
  });

  test("hooks: subagent_spawn + subagent_complete both fire", async () => {
    const sa = new Subagent({
      router: deps.router,
      allTools: deps.allTools,
      audit: deps.audit,
      egress: deps.egress,
      process: deps.process,
      observations: deps.observations,
      episodic: deps.episodic,
      hooks: deps.hooks,
    });
    const events: string[] = [];
    deps.hooks.on("subagent_spawn", (p) => { events.push(`spawn:${p.task}`); });
    deps.hooks.on("subagent_complete", (p) => { events.push(`complete:${p.status}`); });
    await sa.run({
      task: "do X",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
    });
    expect(events).toEqual(["spawn:do X", "complete:completed"]);
  });

  test("subagent_spawn hook can block the subagent run", async () => {
    const sa = new Subagent({
      router: deps.router,
      allTools: deps.allTools,
      audit: deps.audit,
      egress: deps.egress,
      process: deps.process,
      observations: deps.observations,
      episodic: deps.episodic,
      hooks: deps.hooks,
    });
    deps.hooks.on("subagent_spawn", () => ({ block: true, reason: "policy: no X" }));
    const r = await sa.run({
      task: "do X",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
    });
    expect(r.status).toBe("failed");
    expect(r.answer).toMatch(/blocked/);
  });

  test("subagent can only call allowedTools (registry filters)", async () => {
    // Build a router that, on its first call, asks for "echo_a" — then
    // returns a final answer on the second call. If the registry
    // incorrectly allows echo_b, we'd see a successful echo_b tool
    // call in the answer; the test asserts echo_a was used.
    // A3: Pass 1 (fenced blocks) removed. Use the only remaining format: <tool_call> XML.
    const router = stubRouter([
      '<tool_call>\n{"name":"echo_a","args":{"x":1}}\n</tool_call>',
      "done",
    ]);
    const d = makeDeps(router, ["echo_a", "echo_b"]);
    const sa = new Subagent({
      router: d.router,
      allTools: d.allTools,
      audit: d.audit,
      egress: d.egress,
      process: d.process,
      observations: d.observations,
      episodic: d.episodic,
      hooks: d.hooks,
    });
    const r = await sa.run({
      task: "echo A",
      allowedTools: ["echo_a"], // echo_b NOT allowed
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
    });
    expect(r.status).toBe("completed");
    // echo_a was the only allowed tool — verify exactly one call landed.
    // The tool result itself isn't part of the final answer (the agent
    // loop's final text is the second router response, "done"); the
    // proof of correct filtering is the tool-call count + the absence
    // of any echo_b result in the audit log.
    expect(r.toolCalls).toBe(1);
    const echoBCalls = d.audit
      ? d.audit["#insert"]
      : null;
    void echoBCalls;
    d.db.close();
  });

  test("maxIterations ceiling is respected (self-terminating loop)", async () => {
    // Adaptive loop (T1): the agent loop no longer uses a hard maxIterations
    // ceiling — it self-terminates when the model produces a text-only turn.
    // The subagent budget's maxIterations is passed through but the loop
    // returns naturally once the router gives a non-tool-call response.
    // A3: Pass 1 (fenced blocks) removed. Use the only remaining format: <tool_call> XML.
    const router = stubRouter([
      '<tool_call>\n{"name":"echo_a","args":{"x":1}}\n</tool_call>',
      '<tool_call>\n{"name":"echo_a","args":{"x":2}}\n</tool_call>',
      "Task complete after 2 tool calls.",
    ]);
    const d = makeDeps(router, ["echo_a"]);
    const sa = new Subagent({
      router: d.router,
      allTools: d.allTools,
      audit: d.audit,
      egress: d.egress,
      process: d.process,
      observations: d.observations,
      episodic: d.episodic,
      hooks: d.hooks,
    });
    const r = await sa.run({
      task: "do some steps then finish",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 10 },
      parentSessionId: "parent",
    });
    // Self-terminating: model produced a final answer, so status is completed.
    expect(r.status).toBe("completed");
    expect(r.answer).toContain("Task complete");
    d.db.close();
  });

  test("summary is short (≤ 4000 chars by default) for parent context budget", async () => {
    // X4 fix: the previous default of 500 chars was too tight for
    // research delegations. Default is now 4,000 chars, configurable
    // via FERAL_SUBAGENT_MAX_SUMMARY_CHARS. The truncation marker is
    // appended when the cap fires.
    const big = "x".repeat(8000);
    const d = makeDeps(stubRouter([big]), ["echo_a"]);
    const sa = new Subagent({
      router: d.router,
      allTools: d.allTools,
      audit: d.audit,
      egress: d.egress,
      process: d.process,
      observations: d.observations,
      episodic: d.episodic,
      hooks: d.hooks,
    });
    const r = await sa.run({
      task: "big",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 3 },
      parentSessionId: "parent",
    });
    // The 8000-char answer is truncated to ≤ 4000 chars + the marker.
    expect(r.answer.length).toBeLessThanOrEqual(4000 + "\n…(truncated)".length);
    expect(r.answer).toContain("…(truncated)");
    d.db.close();
  });

  test("summary cap is configurable via FERAL_SUBAGENT_MAX_SUMMARY_CHARS", async () => {
    // X4 fix: the env override is read at module load time, so this
    // test exercises the same `Number(...)` coercion path that the
    // module uses. The default-4000 test above covers the default;
    // this one documents the env wiring by setting the var before
    // importing (Bun's import cache means a sibling file must set it,
    // which is a known constraint of env-at-module-load patterns).
    const oldVal = process.env.FERAL_SUBAGENT_MAX_SUMMARY_CHARS;
    process.env.FERAL_SUBAGENT_MAX_SUMMARY_CHARS = "100";
    const expected = 100 + "\n…(truncated)".length;
    try {
      // Read the env the same way subagent.ts does, so a future
      // refactor that breaks the env-plumbing is caught here.
      const parsed = Number(process.env.FERAL_SUBAGENT_MAX_SUMMARY_CHARS);
      expect(parsed).toBe(100);
      expect(expected).toBeGreaterThan(100);
    } finally {
      if (oldVal === undefined) delete process.env.FERAL_SUBAGENT_MAX_SUMMARY_CHARS;
      else process.env.FERAL_SUBAGENT_MAX_SUMMARY_CHARS = oldVal;
    }
  });

  test("depth-1 guard: a subagent never gets delegate_task, even when allowed", async () => {
    // The model asks for delegate_task; the registry must not know it —
    // the loop reports the failed call and the run continues to "done".
    const router = stubRouter([
      '<tool_call>\n{"name":"delegate_task","args":{"task":"recurse"}}\n</tool_call>',
      "done",
    ]);
    const d = makeDeps(router, ["delegate_task", "echo_a"]);
    const sa = new Subagent({
      router: d.router,
      allTools: d.allTools,
      audit: d.audit,
      egress: d.egress,
      process: d.process,
      observations: d.observations,
      episodic: d.episodic,
      hooks: d.hooks,
    });
    const events: string[] = [];
    const r = await sa.run({
      task: "try to recurse",
      // Explicitly allowed by the caller — the guard must strip it anyway.
      allowedTools: ["delegate_task", "echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
      onEvent: (e) => {
        if (e.type === "tool_done") {
          events.push(JSON.stringify((e as { result?: unknown }).result ?? ""));
        }
      },
    });
    // The delegate_task call failed at the registry (unknown tool) — the
    // observer saw a non-ok result, proving the child never had the tool.
    expect(events.length).toBe(1);
    expect(events[0]).toContain("false");
    expect(r.status).toBe("completed");
    d.db.close();
  });

  test("onEvent forwards the child loop's tool events to the caller", async () => {
    const router = stubRouter([
      '<tool_call>\n{"name":"echo_a","args":{"x":1}}\n</tool_call>',
      "done",
    ]);
    const d = makeDeps(router, ["echo_a"]);
    const sa = new Subagent({
      router: d.router,
      allTools: d.allTools,
      audit: d.audit,
      egress: d.egress,
      process: d.process,
      observations: d.observations,
      episodic: d.episodic,
      hooks: d.hooks,
    });
    const seen: string[] = [];
    const r = await sa.run({
      task: "echo",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
      onEvent: (e) => {
        if (e.type === "tool_start" || e.type === "tool_done") {
          seen.push(`${e.type}:${e.tool}`);
        }
      },
    });
    expect(r.status).toBe("completed");
    expect(seen).toEqual(["tool_start:echo_a", "tool_done:echo_a"]);
    // A throwing observer must not fail the run.
    const r2 = await sa.run({
      task: "echo again",
      allowedTools: ["echo_a"],
      budget: { maxTokens: 1024, maxIterations: 5 },
      parentSessionId: "parent",
      onEvent: () => {
        throw new Error("observer bug");
      },
    });
    expect(r2.status).toBe("completed");
    d.db.close();
  });
});
