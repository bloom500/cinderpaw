import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { beginTask, finishTask, setTaskFeedback } from "../src/telemetry/task-metrics.ts";
import { bucketOf, modelLabel, rollup } from "../src/telemetry/usage-rollup.ts";

function call(db: ReturnType<typeof openDatabase>, task: string, provider: string, model: string, pin: number, pout: number, cost: number | null) {
  db.raw.query(
    `INSERT INTO completion_cost (ts, session_id, model, base_url, prompt_tokens, completion_tokens, latency_ms, used_fallback, provider, served_model, task_id, retries, cost_usd)
     VALUES (2000, 's', ?, 'x', ?, ?, 1, 0, ?, ?, ?, 0, ?)`,
  ).run(model, pin, pout, provider, model, task, cost);
}

describe("rollup", () => {
  test("a 3-model task counts once; main model gets the outcome and the thumb", () => {
    const db = openDatabase(":memory:");
    beginTask(db.raw, { taskId: "t", sessionId: "s", startedAt: 1500, brsiOn: true, memoryOn: true });
    call(db, "t", "openrouter.ai", "a", 100, 10, 0.01);
    call(db, "t", "openrouter.ai", "b", 1000, 100, 0.05);
    call(db, "t", "local", "qwen3-8b-q4", 50, 5, null);
    finishTask(db.raw, "t", { durationMs: 20_000, outcome: "completed", errorCategory: null, toolCalls: 4, attemptedProvider: "openrouter.ai", attemptedModel: "b" });
    setTaskFeedback(db.raw, "t", "up");
    const g = rollup(db.raw, 0, 10_000);
    const by = Object.fromEntries(g.map((x) => [x.model, x]));
    expect(g.reduce((n, x) => n + x.tasks_main, 0)).toBe(1);
    expect(by["b"]!.tasks_main).toBe(1);
    expect(by["b"]!.outcomes.completed).toBe(1);
    expect(by["b"]!.thumbs_up).toBe(1);
    expect(by["b"]!.duration_buckets[bucketOf(20_000)]).toBe(1);
    expect(by["b"]!.by_flags["brsi1_mem1"]).toEqual({ tasks: 1, completed: 1, up: 1, down: 0 });
    expect(by["a"]!.tasks_part).toBe(1);
    expect(by["a"]!.tasks_main).toBe(0);
    expect(by["qwen3-8b"]!.cost_estimated_usd).toBe(0);
    db.close();
  });

  test("a failed task with no calls is attributed to the attempted model", () => {
    const db = openDatabase(":memory:");
    beginTask(db.raw, { taskId: "f", sessionId: "s", startedAt: 1500, brsiOn: false, memoryOn: false });
    finishTask(db.raw, "f", { durationMs: 100, outcome: "error", errorCategory: "auth", toolCalls: 0, attemptedProvider: "anthropic.com", attemptedModel: "claude-x" });
    const [g] = rollup(db.raw, 0, 10_000);
    expect(g).toMatchObject({ provider: "anthropic.com", model: "claude-x", tasks_main: 1 });
    expect(g!.errors.auth).toBe(1);
    expect(g!.outcomes.error).toBe(1);
    db.close();
  });

  test("unknown local model becomes local-other", () => {
    expect(modelLabel("local", "maria-notes-q4.gguf")).toBe("local-other");
    expect(modelLabel("local", "Qwen3-8B-Q4_K_M.gguf")).toBe("qwen3-8b");
    expect(modelLabel("local", "gemma-3-4b-it-Q8_0.gguf")).toBe("gemma-3-4b-it");
    expect(modelLabel("local", "gpt-oss-20b")).toBe("gpt-oss-20b");
    // A known family followed by a name keeps only the family part.
    expect(modelLabel("local", "llama-maria-notes-q4.gguf")).toBe("llama");
    expect(modelLabel("openrouter.ai", "anthropic/claude-sonnet-5.5")).toBe("anthropic/claude-sonnet-5.5");
  });

  test("unfinished tasks and tasks outside the window are ignored", () => {
    const db = openDatabase(":memory:");
    beginTask(db.raw, { taskId: "open", sessionId: "s", startedAt: 1500, brsiOn: false, memoryOn: false });
    beginTask(db.raw, { taskId: "old", sessionId: "s", startedAt: 5, brsiOn: false, memoryOn: false });
    finishTask(db.raw, "old", { durationMs: 1, outcome: "completed", errorCategory: null, toolCalls: 0, attemptedProvider: "p", attemptedModel: "m" });
    expect(rollup(db.raw, 1000, 10_000)).toEqual([]);
    db.close();
  });
});
