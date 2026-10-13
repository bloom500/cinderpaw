import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { beginTask, finishTask, noteTaskFallback, setTaskFeedback } from "../src/telemetry/task-metrics.ts";
import { providerOf } from "../src/telemetry/provider-label.ts";
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
    expect(by["b"]!.provider).toBe("openrouter");
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
    expect(g).toMatchObject({ provider: "anthropic", model: "claude-x", tasks_main: 1 });
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
    // Ollama names use `:` for the tag (final review S5).
    expect(modelLabel("local", "qwen3:8b")).toBe("qwen3-8b");
    expect(modelLabel("local", "llama3.1:8b")).toBe("llama3.1-8b");
    expect(modelLabel("local", "maria-diary:latest")).toBe("local-other");
    expect(modelLabel("local", "qwen3:maria")).toBe("qwen3");
    expect(modelLabel("openrouter", "anthropic/claude-sonnet-5.5")).toBe("anthropic/claude-sonnet-5.5");
  });

  test("a fine-tune named after a person's account stays home", () => {
    expect(modelLabel("together", "maria-pop/support-bot-v2")).toBe("together-other");
    expect(modelLabel("huggingface", "dariusr/my-notes-lora")).toBe("huggingface-other");
    expect(modelLabel("deepinfra", "meta-llama/Llama-3.3-70B-Instruct")).toBe("meta-llama/Llama-3.3-70B-Instruct");
    expect(modelLabel("together", "Qwen/Qwen3-235B-A22B")).toBe("Qwen/Qwen3-235B-A22B");
    // OpenRouter lists only public models, so community authors stay visible there.
    expect(modelLabel("openrouter", "thedrummer/rocinante-12b")).toBe("thedrummer/rocinante-12b");
  });

  // Final review M1: these five left the machine as hostname + raw name.
  test("what leaves names a public provider and a public model, never a host or a file name", () => {
    const db = openDatabase(":memory:");
    const probes = [
      ["http://192.168.1.20:11434", "maria-diary:latest"],
      ["https://gpu.popescu-family.ro/v1", "popescu-finetune-v2"],
      ["https://acme-corp.openai.azure.com", "darius-gpt4o-prod"],
      ["https://api.openai.com/v1", "ft:gpt-4o-mini-2024-07-18:acme-corp:support-bot:9abc"],
      ["http://host.docker.internal:1234", "maria-notes"],
    ] as const;
    probes.forEach(([url, model], i) => {
      beginTask(db.raw, { taskId: `p${i}`, sessionId: "s", startedAt: 1500, brsiOn: false, memoryOn: false });
      call(db, `p${i}`, providerOf(url), model, 100, 10, null);
      finishTask(db.raw, `p${i}`, { durationMs: 100, outcome: "completed", errorCategory: null, toolCalls: 0, attemptedProvider: providerOf(url), attemptedModel: model });
    });
    const got = rollup(db.raw, 0, 10_000).map((g) => [g.provider, g.model]);
    expect(got).toEqual([
      ["local", "local-other"],
      ["custom", "custom-other"],
      ["openai", "gpt-4o-mini-2024-07-18"],
    ]);
    const sent = JSON.stringify(rollup(db.raw, 0, 10_000));
    for (const leak of ["192.168", "popescu", "azure", "acme", "darius", "maria", "docker", "support-bot"]) expect(sent).not.toContain(leak);
    db.close();
  });

  test("nothing on your own machine or your own server gets a cloud price", () => {
    const db = openDatabase(":memory:");
    beginTask(db.raw, { taskId: "t", sessionId: "s", startedAt: 1500, brsiOn: false, memoryOn: false });
    call(db, "t", "192.168.1.20", "gpt-4o", 100_000, 10_000, null);
    call(db, "t", "gpu.popescu-family.ro", "gpt-4o", 100_000, 10_000, null);
    finishTask(db.raw, "t", { durationMs: 100, outcome: "completed", errorCategory: null, toolCalls: 0, attemptedProvider: "local", attemptedModel: "gpt-4o" });
    for (const g of rollup(db.raw, 0, 10_000)) expect(g.cost_estimated_usd).toBe(0);
    db.close();
  });

  test("fine-tunes and account-scoped ids keep only what is public", () => {
    expect(modelLabel("openai", "ft:gpt-4o-mini-2024-07-18:acme-corp:support-bot:9abc")).toBe("gpt-4o-mini-2024-07-18");
    expect(modelLabel("mistral", "ft:open-mistral-7b:587a6b29:20240514:7e773925")).toBe("open-mistral-7b");
    expect(modelLabel("fireworks", "accounts/maria-popescu/models/diary-v2")).toBe("fireworks-other");
    expect(modelLabel("volcengine", "ep-20250101123456-abcde")).toBe("volcengine-other");
    expect(modelLabel("custom", "qwen3-8b-instruct")).toBe("qwen3-8b-instruct");
    expect(modelLabel("custom", "ft:gpt-4o-mini:acme:bot:1")).toBe("gpt-4o");
    // The worker refuses names outside its charset; a whole day would be lost.
    expect(modelLabel("openrouter", "my model (copy)")).toBe("openrouter-other");
  });

  // Spec 1.5: fallbacks = calls the router answered from the fallback engine + Brain Stack fallbacks.
  test("router fallbacks count into the task's fallbacks", () => {
    const db = openDatabase(":memory:");
    beginTask(db.raw, { taskId: "t", sessionId: "s", startedAt: 1500, brsiOn: false, memoryOn: false });
    call(db, "t", "openrouter.ai", "b", 1000, 100, 0.05);
    call(db, "t", "local", "qwen3-8b", 10, 1, null);
    db.raw.query("UPDATE completion_cost SET used_fallback = 1 WHERE provider = 'local'").run();
    noteTaskFallback(db.raw, "t");
    finishTask(db.raw, "t", { durationMs: 100, outcome: "completed", errorCategory: null, toolCalls: 0, attemptedProvider: "openrouter.ai", attemptedModel: "b" });
    const by = Object.fromEntries(rollup(db.raw, 0, 10_000).map((g) => [g.model, g]));
    expect(by["b"]!.fallbacks).toBe(2);
    expect(by["qwen3-8b"]!.fallbacks).toBe(0);
    db.close();
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

// Final review M3: the worker now refuses groups whose numbers disagree.
// Whatever the app really sends has to pass it, or a whole day is lost.
test("a real day's payload passes the worker's checks", async () => {
  const { validatePayload } = await import("../../workers/bug-report/usage.js");
  const { buildPayload } = await import("../src/telemetry/usage-sender.ts");
  const db = openDatabase(":memory:");
  const at = Date.parse("2026-10-09T10:00:00Z");
  const task = (id: string, outcome: "completed" | "error" | "no_answer" | "stopped", calls: Array<[string, string, number]>, extra: { category?: "auth"; feedback?: "up" | "down"; brsi?: boolean } = {}) => {
    beginTask(db.raw, { taskId: id, sessionId: "s", startedAt: at, brsiOn: extra.brsi ?? false, memoryOn: true });
    for (const [prov, model, tokens] of calls) call(db, id, prov, model, tokens, 10, null);
    finishTask(db.raw, id, { durationMs: 7_000, outcome, errorCategory: extra.category ?? null, toolCalls: 2, attemptedProvider: "openrouter.ai", attemptedModel: "anthropic/claude-sonnet-5.5" });
    if (extra.feedback) setTaskFeedback(db.raw, id, extra.feedback);
  };
  task("a", "completed", [["openrouter.ai", "anthropic/claude-sonnet-5.5", 900], ["local", "qwen3:8b", 50]], { feedback: "up", brsi: true });
  task("b", "completed", [["192.168.1.20", "maria-diary:latest", 500]], { feedback: "down" });
  task("c", "no_answer", [["openrouter.ai", "anthropic/claude-sonnet-5.5", 100]]);
  task("d", "error", [], { category: "auth" });
  task("e", "stopped", [["gpu.popescu-family.ro", "popescu-finetune-v2", 40], ["openrouter.ai", "anthropic/claude-sonnet-5.5", 30]]);
  noteTaskFallback(db.raw, "a");
  db.raw.query("UPDATE completion_cost SET used_fallback = 1 WHERE provider = 'local'").run();
  const p = buildPayload(db.raw, "2026-10-09", "a".repeat(32), "2026.10.1", "windows");
  expect(p!.groups.length).toBeGreaterThan(2);
  expect(validatePayload(p, Date.parse("2026-10-10T08:00:00Z"))).toEqual({ ok: true });
  db.close();
});

test("an error always has exactly one category, and a non-error has none", () => {
  const db = openDatabase(":memory:");
  for (const [id, outcome, category] of [["e", "error", null], ["c", "completed", "auth"]] as const) {
    beginTask(db.raw, { taskId: id, sessionId: "s", startedAt: 1500, brsiOn: false, memoryOn: false });
    finishTask(db.raw, id, { durationMs: 100, outcome, errorCategory: category, toolCalls: 0, attemptedProvider: "openrouter.ai", attemptedModel: "m" });
  }
  const [g] = rollup(db.raw, 0, 10_000);
  expect(g!.outcomes.error).toBe(1);
  expect(g!.errors).toMatchObject({ other: 1, auth: 0 });
  db.close();
});

test("a group over the worker's per-day cap is left out, the rest of the day still goes", async () => {
  const { buildPayload } = await import("../src/telemetry/usage-sender.ts");
  const db = openDatabase(":memory:");
  const at = Date.parse("2026-10-09T10:00:00Z");
  db.raw.query(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001)
     INSERT INTO task_metrics (task_id, session_id, started_at, duration_ms, outcome, brsi_on, memory_on, attempted_provider, attempted_model)
     SELECT 'bot' || i, 's', ?, 10, 'completed', 0, 0, 'openrouter.ai', 'busy-model' FROM n`,
  ).run(at);
  beginTask(db.raw, { taskId: "h", sessionId: "s", startedAt: at, brsiOn: false, memoryOn: false });
  finishTask(db.raw, "h", { durationMs: 10, outcome: "completed", errorCategory: null, toolCalls: 0, attemptedProvider: "openrouter.ai", attemptedModel: "human-model" });
  const p = buildPayload(db.raw, "2026-10-09", "a".repeat(32), "2026.10.1", "windows");
  expect(p!.groups.map((g) => g.model)).toEqual(["human-model"]);
  db.close();
});
