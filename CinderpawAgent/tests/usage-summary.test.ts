import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { beginTask, finishTask } from "../src/telemetry/task-metrics.ts";
import { usageSummaryReply } from "../src/dispatch.ts";

test("summary: this month's groups, a redacted preview of yesterday, never throws", () => {
  const db = openDatabase(":memory:");
  const now = new Date("2026-10-10T08:00:00Z");
  beginTask(db.raw, { taskId: "t", sessionId: "s", startedAt: Date.parse("2026-10-09T10:00:00Z"), brsiOn: false, memoryOn: true });
  finishTask(db.raw, "t", { durationMs: 2000, outcome: "completed", errorCategory: null, toolCalls: 0, attemptedProvider: "p", attemptedModel: "m" });
  const r = usageSummaryReply("q1", db.raw, now);
  expect(r).toMatchObject({ type: "usage_summary_result", id: "q1", ok: true, month: "2026-10" });
  expect(r.groups).toHaveLength(1);
  expect(r.preview?.day).toBe("2026-10-09");
  expect(r.preview?.code).toBe("(a random code, new every month)");
  db.close();
});
