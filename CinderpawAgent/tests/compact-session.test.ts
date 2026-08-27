/**
 * /compact (OpenClaw slash parity) — AgentLoop.compactSession().
 *
 * Pins the two behaviors the TUI relies on:
 *   1. Unknown / short sessions answer "not needed" (never fabricate work).
 *   2. A long transcript gets summarized NOW (not just when over the
 *      automatic pre-send budget) and answers "compacted".
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
import { AgentLoop } from "../src/core/agent-loop.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function installEchoMock(content: string) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 5 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

function buildAgent(): { agent: AgentLoop; cleanup: () => void } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  new EgressProxy(audit.logger);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
  const agent = new AgentLoop(router, registry, episodic, {}, recall);
  return { agent, cleanup: () => db.close() };
}

describe("AgentLoop.compactSession (/compact)", () => {
  test("unknown session → not needed", async () => {
    const { agent, cleanup } = buildAgent();
    expect(await agent.compactSession("never-seen")).toBe("not needed");
    cleanup();
  });

  test("short transcript → not needed", async () => {
    installEchoMock("short reply");
    const { agent, cleanup } = buildAgent();
    await agent.handle("s1", "hello", "m1", () => {});
    expect(await agent.compactSession("s1")).toBe("not needed");
    cleanup();
  });

  test("long transcript → compacted", async () => {
    installEchoMock("summary of the older turns");
    // A roomy context so the AUTOMATIC pre-send compaction stays out of the
    // way (with the default 8K local budget the big system prompt makes
    // handle() compact every turn, leaving nothing for the manual pass).
    const prev = process.env.CINDERPAW_MAX_CONTEXT;
    process.env.CINDERPAW_MAX_CONTEXT = "65536";
    const { agent, cleanup } = buildAgent();
    // Three ~600-token turns of VARIED text (BPE collapses repeated chars,
    // so "x".repeat(n) counts as almost nothing): big enough to clear the
    // manual thresholds (≥4 turns, ≥1024 transcript tokens) while staying
    // under the automatic pre-send budget — otherwise handle() itself
    // compacts and there is nothing left for the manual pass to fold.
    const varied = (seed: string) =>
      Array.from({ length: 600 }, (_, i) => seed + i).join(" ");
    for (const m of ["m1", "m2", "m3"]) {
      await agent.handle("s2", varied(m), m, () => {});
    }
    expect(await agent.compactSession("s2")).toBe("compacted");
    if (prev === undefined) delete process.env.CINDERPAW_MAX_CONTEXT;
    else process.env.CINDERPAW_MAX_CONTEXT = prev;
    cleanup();
  });
});
