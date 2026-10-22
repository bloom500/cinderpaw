import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { classifyError } from "../src/telemetry/error-category.ts";
import { beginTask, finishTask, noteTaskFallback, setTaskFeedback } from "../src/telemetry/task-metrics.ts";

describe("classifyError", () => {
  const cases: Array<[string, string]> = [
    ["fetch failed: ECONNREFUSED 127.0.0.1", "network"],
    ["401 Unauthorized: invalid api key", "auth"],
    ["402 Payment Required: insufficient credits", "billing"],
    ["429 Too Many Requests", "rate_limit"],
    ["This model's maximum context length is 8192 tokens", "context_overflow"],
    ["503 Service Unavailable", "provider_error"],
    ["tool read_file failed: EACCES", "tool_error"],
    ["something odd", "other"],
  ];
  for (const [text, want] of cases) test(`${want}: ${text}`, () => expect(classifyError(text)).toBe(want));
});

describe("task rows", () => {
  test("begin, fallback, finish, feedback", () => {
    const db = openDatabase(":memory:");
    beginTask(db.raw, { taskId: "t1", sessionId: "s1", startedAt: 1000, brsiOn: true, memoryOn: false });
    noteTaskFallback(db.raw, "t1");
    finishTask(db.raw, "t1", { durationMs: 4200, outcome: "completed", errorCategory: null, toolCalls: 3, attemptedProvider: "openrouter.ai", attemptedModel: "m" });
    setTaskFeedback(db.raw, "t1", "down");
    const r = db.raw.query("SELECT * FROM task_metrics WHERE task_id = 't1'").get() as Record<string, unknown>;
    expect(r).toMatchObject({ session_id: "s1", started_at: 1000, duration_ms: 4200, outcome: "completed", tool_calls: 3, fallbacks: 1, brsi_on: 1, memory_on: 0, feedback: -1 });
    db.close();
  });
  test("feedback on an unknown task is a no-op, not a throw", () => {
    const db = openDatabase(":memory:");
    expect(() => setTaskFeedback(db.raw, "nope", "up")).not.toThrow();
    db.close();
  });
});
