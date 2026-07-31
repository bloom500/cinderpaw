/**
 * Pre-release hardening (2026-07-31) — C-02: outcome-aware no-progress hard stop.
 *
 * Before this change FERAL's only loop signal was `recentToolKeys`, keyed on
 * `name:args` alone. It could WARN ("you are looping") but never stop, so a model
 * that ignored the nudge ran to `ABSOLUTE_CEILING` (500 iterations) or the wall
 * clock — on a cloud provider, real money spent re-issuing an identical call.
 *
 * The new tier blocks only on identical arguments AND identical output, which is
 * definitionally zero progress. The tests below pin both halves of that contract:
 * it must stop a stuck loop, and it must NOT stop a productive one whose output
 * advances (the false-positive an argument-only rule would produce).
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
import { AgentLoop, NO_PROGRESS_STOP, resultDigest } from "../src/core/agent-loop.ts";
import type { Tool } from "../src/types.ts";

const BUDGET = { perConversation: 500_000, perDay: 5_000_000, onExhausted: "stop" } as const;

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

/** Model that always asks for the same tool call, forever. */
function installLoopingModel(toolName: string, args: Record<string, unknown> = {}) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const body = `<tool_call>${JSON.stringify({ name: toolName, args })}</tool_call>`;
    return new Response(
      JSON.stringify({ message: { content: body }, prompt_eval_count: 1, eval_count: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = original);
  return { modelCalls: () => calls };
}

function buildAgent(db: ReturnType<typeof openDatabase>, registry: ToolRegistry): AgentLoop {
  const audit = new AuditLog(db.raw);
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
  return new AgentLoop(router, registry, episodic, {}, recall);
}

function newRegistry(db: ReturnType<typeof openDatabase>): ToolRegistry {
  const audit = new AuditLog(db.raw);
  return new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
}

/** Tool whose output never changes — a genuinely stuck call. */
function frozenTool(name: string, calls: { n: number }): Tool {
  return {
    manifest: { name, description: "always the same", permissions: [], networkAccess: false },
    parameters: {},
    async execute() {
      calls.n++;
      return { ok: true, content: "IDENTICAL OUTPUT" };
    },
  } as Tool;
}

/** Tool whose output advances every call — a productive repeat. */
function advancingTool(name: string, calls: { n: number }): Tool {
  return {
    manifest: { name, description: "advances", permissions: [], networkAccess: false },
    parameters: {},
    async execute() {
      calls.n++;
      return { ok: true, content: `progress step ${calls.n}` };
    },
  } as Tool;
}

describe("resultDigest", () => {
  test("identical text digests identically, different text does not", () => {
    expect(resultDigest("abc")).toBe(resultDigest("abc"));
    expect(resultDigest("abc")).not.toBe(resultDigest("abd"));
  });

  test("degrades instead of throwing on lone surrogates", () => {
    const lone = `bad \uD800 surrogate`;
    expect(typeof resultDigest(lone)).toBe("string");
    expect(resultDigest(lone).length).toBeGreaterThan(0);
  });
});

describe("C-02 — a proven no-progress loop is stopped", () => {
  test("identical args + identical output stops the turn at the threshold", async () => {
    installLoopingModel("frozen");
    const db = openDatabase(":memory:");
    const registry = newRegistry(db);
    const calls = { n: 0 };
    registry.register(frozenTool("frozen", calls));

    const out = await buildAgent(db, registry).handle("s-stuck", "do the thing", "m1", () => {});

    // Stopped at the threshold, nowhere near ABSOLUTE_CEILING (500).
    expect(calls.n).toBe(NO_PROGRESS_STOP);
    db.close();
    void out;
  });

  test("the user is told which tool got stuck, not given a generic ceiling message", async () => {
    installLoopingModel("frozen");
    const db = openDatabase(":memory:");
    const registry = newRegistry(db);
    const calls = { n: 0 };
    registry.register(frozenTool("frozen", calls));

    let finalText = "";
    await buildAgent(db, registry).handle("s-stuck2", "do the thing", "m1", (ev) => {
      if (ev.type === "done") finalText = ev.content;
    });

    expect(finalText).toContain("frozen");
    expect(finalText).toContain("same result");
    // Must not blame task scope — that is the ABSOLUTE_CEILING message.
    expect(finalText).not.toContain("too open-ended");
    db.close();
  });
});

describe("C-02 — a productive repeat is NOT stopped", () => {
  test("same tool + same args but ADVANCING output runs past the threshold", async () => {
    installLoopingModel("advancing");
    const db = openDatabase(":memory:");
    const registry = newRegistry(db);
    const calls = { n: 0 };
    registry.register(advancingTool("advancing", calls));

    await buildAgent(db, registry).handle("s-poll", "poll until done", "m1", () => {});

    // The no-progress rule must not fire: output differs every call. The turn is
    // bounded by the existing ceiling/clock instead, which is the pre-existing
    // contract — the point is only that THIS tier did not cut it short.
    expect(calls.n).toBeGreaterThan(NO_PROGRESS_STOP);
    db.close();
  });
});
