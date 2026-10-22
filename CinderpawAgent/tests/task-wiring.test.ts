import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import type { InferenceConfig } from "../src/types.ts";

const REAL_FETCH = globalThis.fetch;
afterEach(() => (globalThis.fetch = REAL_FETCH));
const BUDGET = { perConversation: 500_000, perDay: 5_000_000, onExhausted: "stop" } as const;

function router(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const db = openDatabase(":memory:");
  const config: InferenceConfig = {
    primary: { provider: "openai", model: "m-asked", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
    trustedBaseUrls: ["https://openrouter.ai/api/v1"],
    tokenBudget: BUDGET,
  };
  return { db, r: new InferenceRouter(config, new AuditLog(db.raw).logger, db.raw) };
}

describe("task wiring", () => {
  test("completions inside a task carry its id; the row closes with the outcome", async () => {
    const { db, r } = router(200, { model: "m-served", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    r.beginTask("s1", "t1", { brsiOn: false, memoryOn: true });
    await r.complete({ sessionId: "s1", messages: [{ role: "user", content: "hi" }] });
    r.endTask("s1", { outcome: "completed", toolCallCount: 2 }, 1500);
    await r.complete({ sessionId: "s1", messages: [{ role: "user", content: "after" }] });
    const calls = db.raw.query("SELECT task_id FROM completion_cost ORDER BY id").all() as Array<{ task_id: string | null }>;
    expect(calls.map((c) => c.task_id)).toEqual(["t1", null]);
    const t = db.raw.query("SELECT * FROM task_metrics").get() as Record<string, unknown>;
    expect(t).toMatchObject({ task_id: "t1", outcome: "completed", tool_calls: 2, duration_ms: 1500, memory_on: 1 });
    db.close();
  });

  test("failed turn with no completion is attributed to the attempted model", () => {
    const { db, r } = router(200, {});
    r.beginTask("s1", "t2", { brsiOn: false, memoryOn: false });
    r.endTask("s1", { outcome: "no_answer", toolCallCount: 0, diagnostic: "401 Unauthorized: invalid api key", failed: true }, 300);
    const t = db.raw.query("SELECT * FROM task_metrics").get() as Record<string, unknown>;
    expect(t).toMatchObject({ outcome: "error", error_category: "auth", attempted_provider: "openrouter.ai", attempted_model: "m-asked" });
    db.close();
  });

  test("a subagent's turn joins its parent's task instead of counting as a new one", async () => {
    const { db, r } = router(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    r.beginTask("s1", "t1", { brsiOn: false, memoryOn: false });
    const child = "subagent:s1:sa1";
    r.beginTask(child, "child-msg", { brsiOn: false, memoryOn: false });
    await r.complete({ sessionId: child, messages: [{ role: "user", content: "sub" }] });
    r.endTask(child, { outcome: "completed", toolCallCount: 1 }, 50);
    r.endTask("s1", { outcome: "completed", toolCallCount: 1 }, 100);
    expect(db.raw.query("SELECT task_id FROM task_metrics").all()).toEqual([{ task_id: "t1" }]);
    expect(db.raw.query("SELECT task_id FROM completion_cost").all()).toEqual([{ task_id: "t1" }]);
    db.close();
  });

  test("a turn that never returned a result is an error, category other", () => {
    const { db, r } = router(200, {});
    r.beginTask("s1", "t3", { brsiOn: false, memoryOn: false });
    r.endTask("s1", undefined, 10);
    expect((db.raw.query("SELECT outcome, error_category FROM task_metrics").get() as Record<string, unknown>)).toEqual({ outcome: "error", error_category: "other" });
    db.close();
  });
});

// The outcome a whole turn records, driven through a real AgentLoop.
describe("task outcome from a real turn", () => {
  function agentWith(reply: () => Response) {
    globalThis.fetch = (async () => reply()) as unknown as typeof fetch;
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const router = new InferenceRouter(
      { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
      audit.logger,
      db.raw,
    );
    const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
    const agent = new AgentLoop(router, registry, new EpisodicMemory(db.raw, audit.logger), {});
    const row = () => db.raw.query("SELECT outcome, error_category FROM task_metrics").get();
    return { db, router, agent, row };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // Final review S4: a model that answered with nothing is `no_answer`, not a failure.
  test("an empty answer is no_answer, not error", async () => {
    const { db, agent, row } = agentWith(() => json(200, { message: { content: "" }, prompt_eval_count: 5, eval_count: 0 }));
    const r = await agent.handleTurn("s1", "hi", "m1", () => {});
    expect(r.outcome).toBe("no_answer");
    expect(row()).toEqual({ outcome: "no_answer", error_category: null });
    db.close();
  });

  test("a provider error is error, with its category", async () => {
    const { db, agent, row } = agentWith(() => json(401, { error: "unauthorized" }));
    await agent.handleTurn("s1", "hi", "m1", () => {});
    expect(row()).toEqual({ outcome: "error", error_category: "auth" });
    db.close();
  });

  // Final review S8: telemetry must never leave a session locked.
  test("a throwing endTask does not cost the turn or lock the session", async () => {
    const { db, router, agent } = agentWith(() => json(200, { message: { content: "hello" }, prompt_eval_count: 5, eval_count: 1 }));
    router.endTask = () => { throw new Error("stats broke"); };
    const first = await agent.handleTurn("s1", "hi", "m1", () => {});
    expect(first.text).toContain("hello");
    const second = await Promise.race([agent.handleTurn("s1", "again", "m2", () => {}), Bun.sleep(5_000).then(() => null)]);
    expect(second?.outcome).toBe("completed");
    db.close();
  });
});
