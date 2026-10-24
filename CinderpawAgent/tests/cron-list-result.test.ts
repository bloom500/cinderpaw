/**
 * `cron_list` used to answer with a `model_set` carrying only "jobs:N", so no
 * client could show a single scheduled task. `cinderpaw cron` reads this reply.
 */
import { expect, test } from "bun:test";
import { cronListResult } from "../src/dispatch.ts";
import type { CronJob } from "../src/types.ts";

const job: CronJob = {
  id: "j1",
  name: "Morning news",
  task: "Summarize the news",
  schedule: { kind: "every", intervalMs: 86_400_000 },
  delivery: { kind: "webhook", url: "https://example.invalid/hook" },
  enabled: true,
  nextRunMs: 5,
  kind: "agent",
  history: [{ ts: 1, ok: true } as never],
} as CronJob;

test("the list carries each task, and nothing a person does not need", () => {
  const r = cronListResult("q1", [job]);
  expect(r).toMatchObject({ type: "cron_list_result", id: "q1", ok: true });
  // The last few results ride along for the Tasks page; the delivery target does not.
  expect(r.jobs).toEqual([{ id: "j1", name: "Morning news", task: "Summarize the news", schedule: job.schedule, enabled: true, nextRunMs: 5, lastRunMs: undefined, kind: "agent", history: job.history }]);
  expect(JSON.stringify(r)).not.toContain("example.invalid");
});

test("a failed change says why and still shows the list", () => {
  const r = cronListResult("q2", [job], "No task with that id.");
  expect(r.ok).toBe(false);
  expect(r.error).toBe("No task with that id.");
  expect(r.jobs).toHaveLength(1);
});
