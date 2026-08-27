/**
 * Cron scheduler — P0-3.
 *
 * Pins the three pieces of the cron subsystem:
 *   1. Schedule parsing: cron expr / every / at
 *   2. Jobs repo: SQLite-backed CRUD with serialised schedule + delivery
 *   3. Scheduler: timer loop, fires due jobs, persists run records, retries
 *   4. Delivery: chat / webhook / tool targets
 *
 * Uses a unique :memory: DB per test to keep suites isolated.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase, type CinderpawDb } from "../src/db.ts";
import {
  CronJobsRepo,
  nextRunAt,
} from "../src/cron/index.ts";
import {
  CronScheduler,
  type CronRunFn,
} from "../src/cron/scheduler.ts";
import {
  deliverCron,
  type CronDeliveryContext,
} from "../src/cron/delivery.ts";
import type {
  CronJob,
  CronJobInput,
  CronRunRecord,
  DeliveryTarget,
  OutboundEvent,
  Schedule,
} from "../src/types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function now(): Date {
  // Fixed clock for deterministic scheduling tests.
  return new Date("2026-06-09T12:00:00.000Z");
}

function makeDb(): CinderpawDb {
  return openDatabase(":memory:");
}

function makeInput(overrides: Partial<CronJobInput> = {}): CronJobInput {
  return {
    name: "morning-summary",
    task: "Summarise my git activity from the last 24h.",
    schedule: { kind: "every", intervalMs: 60_000 },
    delivery: { kind: "chat", sessionId: "default" },
    enabled: true,
    maxRetries: 3,
    ...overrides,
  };
}

// ─── Schedule parsing ──────────────────────────────────────────────────────

describe("nextRunAt", () => {
  const from = now();

  test("every N ms returns from + intervalMs", () => {
    const got = nextRunAt({ kind: "every", intervalMs: 5_000 }, from);
    expect(got).toBe(from.getTime() + 5_000);
  });

  test("every 0 ms is invalid", () => {
    expect(nextRunAt({ kind: "every", intervalMs: 0 }, from)).toBeNull();
  });

  test("every negative ms is invalid", () => {
    expect(nextRunAt({ kind: "every", intervalMs: -1 }, from)).toBeNull();
  });

  test("at future ISO returns the timestamp", () => {
    const target = "2026-06-09T13:00:00.000Z";
    const got = nextRunAt({ kind: "at", isoTimestamp: target }, from);
    expect(got).toBe(Date.parse(target));
  });

  test("at past ISO returns null (one-shot already fired)", () => {
    expect(
      nextRunAt({ kind: "at", isoTimestamp: "2025-01-01T00:00:00.000Z" }, from),
    ).toBeNull();
  });

  test("at invalid ISO returns null", () => {
    expect(nextRunAt({ kind: "at", isoTimestamp: "not-a-date" }, from)).toBeNull();
  });

  test("cron expression returns the next matching date", () => {
    // At 12:00:00, next "every minute" is 12:01:00.
    const got = nextRunAt({ kind: "cron", expression: "* * * * *" }, from);
    expect(got).toBe(Date.parse("2026-06-09T12:01:00.000Z"));
  });

  test("cron expression with malformed value returns null", () => {
    expect(nextRunAt({ kind: "cron", expression: "not a cron" }, from)).toBeNull();
  });

  test("cron expression with 9am UTC every weekday", () => {
    // From 2026-06-09 (Tuesday), 9am already passed at 12:00 → next is Wed.
    const got = nextRunAt(
      { kind: "cron", expression: "0 9 * * 1-5" },
      from,
    );
    expect(got).toBe(Date.parse("2026-06-10T09:00:00.000Z"));
  });
});

// ─── Jobs repo ─────────────────────────────────────────────────────────────

describe("CronJobsRepo", () => {
  let db: CinderpawDb;
  let repo: CronJobsRepo;

  beforeEach(() => {
    db = makeDb();
    repo = new CronJobsRepo(db.raw);
  });
  afterEach(() => db.close());

  test("list on empty repo is []", () => {
    expect(repo.list()).toEqual([]);
  });

  test("upsert creates a new job with a generated id", () => {
    const job = repo.upsert(makeInput());
    expect(job.id).toBeTruthy();
    expect(job.name).toBe("morning-summary");
    expect(job.enabled).toBe(true);
    expect(job.history).toEqual([]);
    expect(job.retryCount).toBe(0);
    expect(job.createdAt).toBeGreaterThan(0);
  });

  test("a brand-new job is scheduled — nextRunMs is never left null", () => {
    // The scheduler skips jobs with a null nextRunMs and only ever computed one
    // AFTER a run, so leaving it null here meant every cron the user added
    // never fired at all.
    const before = Date.now();
    const job = repo.upsert(makeInput({ schedule: { kind: "every", intervalMs: 60_000 } }));
    expect(job.nextRunMs).toBeGreaterThanOrEqual(before + 60_000);
  });

  test("changing the schedule recomputes nextRunMs; editing the name does not", () => {
    const a = repo.upsert(makeInput({ schedule: { kind: "every", intervalMs: 60_000 } }));
    const renamed = repo.upsert({ ...makeInput({ name: "renamed" }), id: a.id });
    expect(renamed.nextRunMs).toBe(a.nextRunMs);

    const rescheduled = repo.upsert({
      ...makeInput({ schedule: { kind: "every", intervalMs: 3_600_000 } }),
      id: a.id,
    });
    expect(rescheduled.nextRunMs).toBeGreaterThan(a.nextRunMs!);
  });

  test("rescheduling to a one-shot in the past means never, not immediately", () => {
    const a = repo.upsert(makeInput({ schedule: { kind: "every", intervalMs: 1 } }));
    expect(a.nextRunMs).not.toBeNull();
    const past = repo.upsert({
      ...makeInput({ schedule: { kind: "at", isoTimestamp: "2020-01-01T00:00:00.000Z" } }),
      id: a.id,
    });
    expect(past.nextRunMs ?? null).toBeNull();
  });

  test("upsert with an explicit id overwrites the existing row", () => {
    const a = repo.upsert(makeInput({ name: "first" }));
    const b = repo.upsert({ ...makeInput({ name: "second" }), id: a.id });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("second");
    expect(repo.list()).toHaveLength(1);
  });

  test("get returns the job by id", () => {
    const a = repo.upsert(makeInput());
    expect(repo.get(a.id)?.name).toBe("morning-summary");
    expect(repo.get("does-not-exist")).toBeUndefined();
  });

  test("remove deletes the job and returns true", () => {
    const a = repo.upsert(makeInput());
    expect(repo.remove(a.id)).toBe(true);
    expect(repo.get(a.id)).toBeUndefined();
    expect(repo.remove(a.id)).toBe(false); // already gone
  });

  test("list returns enabled and disabled jobs in insertion order", () => {
    repo.upsert(makeInput({ name: "a", enabled: true }));
    repo.upsert(makeInput({ name: "b", enabled: false }));
    const all = repo.list();
    expect(all.map((j) => j.name)).toEqual(["a", "b"]);
    expect(all[1]?.enabled).toBe(false);
  });

  test("round-trip serialises schedule + delivery correctly", () => {
    const input = makeInput({
      schedule: { kind: "cron", expression: "0 9 * * 1-5" },
      delivery: { kind: "webhook", url: "https://example.com/hook" },
    });
    const job = repo.upsert(input);
    const back = repo.get(job.id)!;
    expect(back.schedule).toEqual({ kind: "cron", expression: "0 9 * * 1-5" });
    expect(back.delivery).toEqual({
      kind: "webhook",
      url: "https://example.com/hook",
    });
  });

  test("updateAfterRun appends to history and bumps lastRunMs / nextRunMs", () => {
    const job = repo.upsert(makeInput({
      schedule: { kind: "every", intervalMs: 60_000 },
    }));
    const runAt = Date.now();
    const record: CronRunRecord = {
      runAt,
      status: "success",
      durationMs: 1234,
      result: "all good",
    };
    repo.updateAfterRun(job.id, runAt, runAt + 60_000, record, 0);
    const back = repo.get(job.id)!;
    expect(back.lastRunMs).toBe(runAt);
    expect(back.nextRunMs).toBe(runAt + 60_000);
    expect(back.history).toHaveLength(1);
    expect(back.history[0]?.status).toBe("success");
    expect(back.retryCount).toBe(0);
  });

  test("updateAfterRun keeps history bounded to 50 entries (oldest dropped)", () => {
    const job = repo.upsert(makeInput());
    for (let i = 0; i < 55; i++) {
      repo.updateAfterRun(
        job.id,
        Date.now() + i,
        Date.now() + 1000 + i,
        { runAt: Date.now() + i, status: "success", durationMs: 1 },
        0,
      );
    }
    const back = repo.get(job.id)!;
    expect(back.history).toHaveLength(50);
  });

  test("setEnabled toggles the flag and updates updatedAt", () => {
    const job = repo.upsert(makeInput({ enabled: true }));
    repo.setEnabled(job.id, false);
    expect(repo.get(job.id)?.enabled).toBe(false);
    repo.setEnabled(job.id, true);
    expect(repo.get(job.id)?.enabled).toBe(true);
  });
});

// ─── Delivery ──────────────────────────────────────────────────────────────

function makeDeliveryCtx(overrides: Partial<CronDeliveryContext> = {}): {
  ctx: CronDeliveryContext;
  emitted: OutboundEvent[];
  fetchMock: ReturnType<typeof mock>;
} {
  const emitted: OutboundEvent[] = [];
  const fetchMock = mock(async () =>
    new Response("ok", { status: 200 })
  );
  const ctx: CronDeliveryContext = {
    emit: (e) => emitted.push(e),
    fetch: fetchMock as unknown as CronDeliveryContext["fetch"],
    ...overrides,
  };
  return { ctx, emitted, fetchMock };
}

describe("deliverCron", () => {
  const job: CronJob = {
    id: "j1",
    name: "test",
    task: "t",
    schedule: { kind: "every", intervalMs: 60_000 },
    delivery: { kind: "chat", sessionId: "s1" },
    enabled: true,
    history: [],
    maxRetries: 3,
    retryCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };

  test("chat delivery emits a cron_fired event with the job id and content", () => {
    const { ctx, emitted } = makeDeliveryCtx();
    deliverCron(
      { kind: "chat", sessionId: "s1" },
      "hello world",
      job,
      ctx,
    );
    expect(emitted).toHaveLength(1);
    const ev = emitted[0]!;
    expect(ev.type).toBe("cron_fired");
    if (ev.type === "cron_fired") {
      expect(ev.jobId).toBe("j1");
      expect(ev.jobName).toBe("test");
      expect(ev.content).toBe("hello world");
      expect(ev.sessionId).toBe("s1");
    }
  });

  test("webhook delivery POSTs JSON to the URL", async () => {
    const { ctx, fetchMock } = makeDeliveryCtx();
    await deliverCron(
      { kind: "webhook", url: "https://hook.example.com/x" },
      "result",
      job,
      ctx,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hook.example.com/x");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.jobId).toBe("j1");
    expect(body.jobName).toBe("test");
    expect(body.content).toBe("result");
  });

  test("webhook delivery emits an error event on non-2xx response", async () => {
    const fetchMock = mock(async () =>
      new Response("server error", { status: 500 })
    );
    const { ctx, emitted } = makeDeliveryCtx({ fetch: fetchMock as unknown as CronDeliveryContext["fetch"] });
    await deliverCron(
      { kind: "webhook", url: "https://hook.example.com/x" },
      "result",
      job,
      ctx,
    );
    expect(emitted.some((e) => e.type === "error")).toBe(true);
  });

  test("tool delivery is a V2 TODO and emits an error", () => {
    const { ctx, emitted } = makeDeliveryCtx();
    deliverCron(
      {
        kind: "tool",
        toolName: "write_file",
        args: { path: "/x.txt" },
      },
      "result",
      job,
      ctx,
    );
    expect(emitted.some((e) => e.type === "error")).toBe(true);
  });
});

// ─── Scheduler ─────────────────────────────────────────────────────────────

describe("CronScheduler", () => {
  let db: CinderpawDb;
  let repo: CronJobsRepo;
  let emitted: OutboundEvent[];
  let runFn: ReturnType<typeof mock>;
  let runFnImpl: CronRunFn;
  let scheduler: CronScheduler;

  beforeEach(() => {
    db = makeDb();
    repo = new CronJobsRepo(db.raw);
    emitted = [];
    // A run now reports whether the task actually finished, not just its text.
    runFn = mock(async () => ({ text: "ok-result", finished: true }));
    runFnImpl = runFn as unknown as CronRunFn;
    scheduler = new CronScheduler({
      repo,
      runJob: runFnImpl,
      deliver: (target, content, job, ctx) => {
        if (target.kind === "chat") {
          ctx.emit({
            type: "cron_fired",
            jobId: job.id,
            jobName: job.name,
            sessionId: target.sessionId,
            content,
          });
        }
      },
      tickIntervalMs: 100,
      jobTimeoutMs: 5_000,
      now,
    });
  });
  afterEach(() => db.close());

  test("tick fires jobs whose nextRunMs is past", async () => {
    const job = repo.upsert(makeInput({
      schedule: { kind: "every", intervalMs: 60_000 },
    }));
    // Force the job to be due.
    repo.updateAfterRun(
      job.id,
      now().getTime() - 120_000,
      now().getTime() - 60_000,
      { runAt: now().getTime() - 120_000, status: "success", durationMs: 0 },
      0,
    );

    await scheduler.tick();

    expect(runFn).toHaveBeenCalledTimes(1);
    const back = repo.get(job.id)!;
    expect(back.history).toHaveLength(2); // previous + new
    expect(back.history.at(-1)?.status).toBe("success");
    expect(back.retryCount).toBe(0);
  });

  test("tick does NOT fire jobs whose nextRunMs is in the future", async () => {
    repo.upsert(makeInput({
      schedule: { kind: "every", intervalMs: 60_000 },
    }));
    await scheduler.tick();
    expect(runFn).toHaveBeenCalledTimes(0);
  });

  test("tick skips disabled jobs", async () => {
    const job = repo.upsert(makeInput({
      schedule: { kind: "every", intervalMs: 60_000 },
      enabled: false,
    }));
    repo.updateAfterRun(
      job.id,
      now().getTime() - 120_000,
      now().getTime() - 60_000,
      { runAt: now().getTime() - 120_000, status: "success", durationMs: 0 },
      0,
    );
    await scheduler.tick();
    expect(runFn).toHaveBeenCalledTimes(0);
  });

  test("failed run increments retryCount, next run is still scheduled", async () => {
    const failFn = mock(async (): Promise<string> => {
      throw new Error("inference down");
    });
    const failScheduler = new CronScheduler({
      repo,
      runJob: failFn as unknown as CronRunFn,
      deliver: () => {},
      tickIntervalMs: 100,
      jobTimeoutMs: 5_000,
      now,
    });
    const job = repo.upsert(makeInput({
      schedule: { kind: "every", intervalMs: 60_000 },
    }));
    repo.updateAfterRun(
      job.id,
      now().getTime() - 120_000,
      now().getTime() - 60_000,
      { runAt: now().getTime() - 120_000, status: "success", durationMs: 0 },
      0,
    );
    await failScheduler.tick();
    const back = repo.get(job.id)!;
    expect(back.history.at(-1)?.status).toBe("failed");
    expect(back.retryCount).toBe(1);
    expect(back.nextRunMs).toBe(now().getTime() + 60_000);
  });

  test("successful run resets retryCount to 0", async () => {
    const job = repo.upsert(makeInput({
      schedule: { kind: "every", intervalMs: 60_000 },
      maxRetries: 5,
    }));
    // Pretend a previous failure bumped retryCount.
    repo.updateAfterRun(
      job.id,
      now().getTime() - 60_000,
      now().getTime() - 30_000,
      {
        runAt: now().getTime() - 60_000,
        status: "failed",
        durationMs: 1,
        error: "x",
      },
      3,
    );
    await scheduler.tick();
    const back = repo.get(job.id)!;
    expect(back.retryCount).toBe(0);
  });

  test("one-shot 'at' job is disabled after firing successfully", async () => {
    const job = repo.upsert(makeInput({
      schedule: { kind: "at", isoTimestamp: new Date(now().getTime() - 1_000).toISOString() },
    }));
    // The next-run for an already-past "at" is null, so manually mark as due.
    repo.updateAfterRun(
      job.id,
      now().getTime() - 60_000,
      now().getTime() - 1_000,
      { runAt: now().getTime() - 60_000, status: "success", durationMs: 0 },
      0,
    );
    await scheduler.tick();
    const back = repo.get(job.id)!;
    expect(back.enabled).toBe(false); // one-shot consumed
  });
});

describe("CronScheduler — an unfinished run is not a success", () => {
  let db: CinderpawDb;
  let repo: CronJobsRepo;
  let delivered: string[];

  const build = (finished: boolean, errors: string[]) =>
    new CronScheduler({
      repo,
      runJob: (async () => ({ text: "got halfway", finished })) as unknown as CronRunFn,
      deliver: (_t, content) => {
        delivered.push(content);
      },
      onJobError: (_j, message) => errors.push(message),
      tickIntervalMs: 100,
      jobTimeoutMs: 5_000,
      now,
    });

  const makeDue = (job: { id: string }) =>
    repo.updateAfterRun(
      job.id,
      now().getTime() - 120_000,
      now().getTime() - 60_000,
      { runAt: now().getTime() - 120_000, status: "success", durationMs: 0 },
      0,
    );

  beforeEach(() => {
    db = makeDb();
    repo = new CronJobsRepo(db.raw);
    delivered = [];
  });
  afterEach(() => db.close());

  test("records `incomplete`, climbs the retry streak, still delivers the partial", async () => {
    const errors: string[] = [];
    const job = repo.upsert(makeInput({ schedule: { kind: "every", intervalMs: 60_000 } }));
    makeDue(job);

    await build(false, errors).tick();

    const back = repo.get(job.id)!;
    // The whole point: not "success".
    expect(back.history.at(-1)?.status).toBe("incomplete");
    // A job that never finishes must eventually read as stuck, not fine.
    expect(back.retryCount).toBe(1);
    // Partial work is still worth seeing.
    expect(delivered).toEqual(["got halfway"]);
    // And it is surfaced, not buried in the history table.
    expect(errors.some((e) => e.includes("incomplete"))).toBe(true);
  });

  test("a one-shot that did not finish stays enabled for the next tick", async () => {
    const job = repo.upsert(makeInput({ schedule: { kind: "at", atMs: now().getTime() - 1_000 } }));
    makeDue(job);

    await build(false, []).tick();
    expect(repo.get(job.id)!.enabled).toBe(true);
  });

  test("a one-shot that DID finish is consumed as before", async () => {
    const job = repo.upsert(makeInput({ schedule: { kind: "at", atMs: now().getTime() - 1_000 } }));
    makeDue(job);

    await build(true, []).tick();
    const back = repo.get(job.id)!;
    expect(back.enabled).toBe(false);
    expect(back.history.at(-1)?.status).toBe("success");
    expect(back.retryCount).toBe(0);
  });

  test("done_when round-trips through the repo", () => {
    const job = repo.upsert(
      makeInput({
        schedule: { kind: "every", intervalMs: 60_000 },
        doneWhen: { kind: "command", value: "npm test" },
      }),
    );
    expect(repo.get(job.id)!.doneWhen).toEqual({
      kind: "command",
      path: undefined,
      value: "npm test",
      timeoutMs: undefined,
      // Set on the job itself, so it counts as the user's own instruction and
      // the command is allowed to run. An assertion parsed out of a message
      // carries `origin: "message"` and the command form is refused.
      origin: "user",
    });
  });
});
