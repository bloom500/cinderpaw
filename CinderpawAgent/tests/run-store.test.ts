/**
 * Durable run state — the row that makes a crashed run findable.
 *
 * `runUnattended` was an in-memory loop: laptop sleep or a sidecar restart at
 * hour 4 lost it with nothing left behind to resume from. These tables are that
 * missing "a run existed, here is its mission, here is where it started".
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { RunStore, type StartRunInput } from "../src/core/run-store.ts";

function store() {
  const { raw, close } = openDatabase(":memory:");
  return { store: new RunStore(raw), raw, close };
}

const MISSION = "add a --json flag to cinderpaw status";

function input(over: Partial<StartRunInput> = {}): StartRunInput {
  return {
    sessionId: "discord:c1:u1",
    mission: MISSION,
    deadlineAt: null,
    continuationBudget: 4,
    safetyRoot: null,
    safetyBefore: null,
    safetyGitDir: null,
    doneWhen: null,
    delivery: null,
    ...over,
  };
}

describe("RunStore", () => {
  test("a started run is findable as running, with its mission intact", () => {
    const { store: s, close } = store();
    const run = s.startRun(input())!;
    expect(run.status).toBe("running");
    expect(s.runningRuns().map((r) => r.id)).toEqual([run.id]);
    expect(s.get(run.id)?.mission).toBe(MISSION);
    close();
  });

  test("a second run on a session that already has one is refused", () => {
    // Two loops driving one transcript is how side effects get performed twice.
    const { store: s, close } = store();
    expect(s.startRun(input())).not.toBeNull();
    expect(s.startRun(input())).toBeNull();
    expect(s.runningRuns()).toHaveLength(1);
    close();
  });

  test("a run on a DIFFERENT session is allowed alongside it", () => {
    const { store: s, close } = store();
    expect(s.startRun(input())).not.toBeNull();
    expect(s.startRun(input({ sessionId: "discord:c2:u9" }))).not.toBeNull();
    expect(s.runningRuns()).toHaveLength(2);
    close();
  });

  test("a finished run frees the session for a new one", () => {
    const { store: s, close } = store();
    const first = s.startRun(input())!;
    s.finish(first.id, "finished", "completed");
    expect(s.startRun(input())).not.toBeNull();
    close();
  });

  test("turns are appended in order and read back whole", () => {
    const { store: s, close } = store();
    const run = s.startRun(input())!;
    const seq1 = s.appendTurn({
      runId: run.id, startedAt: 1000, durationMs: 500, outcome: "out_of_time",
      toolCalls: 3, continuation: false, replan: false, tokens: 1200,
      filesChanged: 2, todosClosed: 1, doneWhenPass: false,
    });
    const seq2 = s.appendTurn({
      runId: run.id, startedAt: 2000, durationMs: 700, outcome: "completed",
      toolCalls: 1, continuation: true, replan: false, tokens: 900,
      filesChanged: 0, todosClosed: 0, doneWhenPass: true,
    });
    expect([seq1, seq2]).toEqual([1, 2]);
    const turns = s.turnsOf(run.id);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.outcome).toBe("out_of_time");
    expect(turns[0]!.continuation).toBe(false);
    expect(turns[1]!.continuation).toBe(true);
    expect(turns[1]!.doneWhenPass).toBe(true);
    expect(turns[0]!.tokens).toBe(1200);
    close();
  });

  test("a turn with no assertion evaluated stores null, not false", () => {
    // false would read as "the check failed"; null is "there was no check".
    const { store: s, close } = store();
    const run = s.startRun(input())!;
    s.appendTurn({
      runId: run.id, startedAt: 1, durationMs: 1, outcome: "completed",
      toolCalls: 0, continuation: false, replan: false, tokens: 0,
      filesChanged: 0, todosClosed: 0, doneWhenPass: null,
    });
    expect(s.turnsOf(run.id)[0]!.doneWhenPass).toBeNull();
    close();
  });

  test("a continuation turn advances continuations_used; a first turn does not", () => {
    const { store: s, close } = store();
    const run = s.startRun(input())!;
    const base = {
      runId: run.id, startedAt: 1, durationMs: 1, outcome: "out_of_time" as const,
      toolCalls: 0, replan: false, tokens: 0, filesChanged: 0, todosClosed: 0,
      doneWhenPass: null,
    };
    s.appendTurn({ ...base, continuation: false });
    expect(s.get(run.id)!.continuationsUsed).toBe(0);
    s.appendTurn({ ...base, continuation: true });
    s.appendTurn({ ...base, continuation: true });
    expect(s.get(run.id)!.continuationsUsed).toBe(2);
    close();
  });

  test("a replan turn latches replan_used, so the one retry cannot be spent twice", () => {
    const { store: s, close } = store();
    const run = s.startRun(input())!;
    expect(s.get(run.id)!.replanUsed).toBe(false);
    s.appendTurn({
      runId: run.id, startedAt: 1, durationMs: 1, outcome: "stuck",
      toolCalls: 0, continuation: true, replan: true, tokens: 0,
      filesChanged: 0, todosClosed: 0, doneWhenPass: null,
    });
    expect(s.get(run.id)!.replanUsed).toBe(true);
    close();
  });

  test("appending a turn touches updated_at, so a stalled run is spottable", () => {
    const { store: s, close } = store();
    const run = s.startRun(input())!;
    const before = s.get(run.id)!.updatedAt;
    s.appendTurn({
      runId: run.id, startedAt: 1, durationMs: 1, outcome: "completed",
      toolCalls: 0, continuation: false, replan: false, tokens: 0,
      filesChanged: 0, todosClosed: 0, doneWhenPass: null,
    });
    expect(s.get(run.id)!.updatedAt).toBeGreaterThanOrEqual(before);
    close();
  });

  test("turns of one run never leak into another", () => {
    const { store: s, close } = store();
    const a = s.startRun(input())!;
    const b = s.startRun(input({ sessionId: "cron:job7" }))!;
    s.appendTurn({
      runId: a.id, startedAt: 1, durationMs: 1, outcome: "completed",
      toolCalls: 0, continuation: false, replan: false, tokens: 0,
      filesChanged: 0, todosClosed: 0, doneWhenPass: null,
    });
    expect(s.turnsOf(a.id)).toHaveLength(1);
    expect(s.turnsOf(b.id)).toHaveLength(0);
    close();
  });

  test("done_when and delivery round-trip as objects, not strings", () => {
    const { store: s, close } = store();
    const run = s.startRun(input({
      doneWhen: { kind: "command", value: "bun test" },
      delivery: { kind: "discord", target: "chan-1", sessionId: "discord:c1:u1" },
    }))!;
    const back = s.get(run.id)!;
    expect(back.doneWhen).toEqual({ kind: "command", value: "bun test" });
    expect(back.delivery?.target).toBe("chan-1");
    close();
  });

  test("a corrupt done_when column reads as null instead of throwing", () => {
    // A row written by a future version must not brick the boot resume pass.
    const { store: s, raw, close } = store();
    const run = s.startRun(input())!;
    raw.query("UPDATE runs SET done_when = ? WHERE id = ?").run("{not json", run.id);
    expect(s.get(run.id)!.doneWhen).toBeNull();
    close();
  });

  test("markResumed bumps the counter and records where the resume began", () => {
    const { store: s, close } = store();
    const run = s.startRun(input())!;
    s.markResumed(run.id, 3);
    const back = s.get(run.id)!;
    expect(back.resumes).toBe(1);
    expect(back.lastResumeSeq).toBe(3);
    close();
  });

  test("a run-level stop reason the loop cannot produce is storable", () => {
    // process_died / resume_cap / no_progress are run-level, and deliberately
    // not part of UnattendedResult["stoppedBecause"] — see digest.ts's
    // exhaustive Record over that type.
    const { store: s, close } = store();
    const run = s.startRun(input())!;
    s.finish(run.id, "unfinished", "process_died");
    expect(s.get(run.id)!.stoppedBecause).toBe("process_died");
    expect(s.runningRuns()).toHaveLength(0);
    close();
  });

  test("deadline is stored as given and not recomputed on read", () => {
    // The whole point of an absolute deadline: it must survive a restart
    // unchanged, or an 8h run gains a fresh 8h every time it is resumed.
    const { store: s, close } = store();
    const at = 1_800_000_000_000;
    const run = s.startRun(input({ deadlineAt: at }))!;
    expect(s.get(run.id)!.deadlineAt).toBe(at);
    close();
  });

  test("running runs come back oldest first", () => {
    // A queue of interrupted runs is worked in the order they were started,
    // not in whatever order SQLite feels like.
    const { store: s, close } = store();
    const first = s.startRun(input({ sessionId: "s1" }))!;
    const second = s.startRun(input({ sessionId: "s2" }))!;
    const ids = s.runningRuns().map((r) => r.id);
    expect(ids).toEqual([first.id, second.id]);
    close();
  });

  // S1 — a row nobody is driving is not a row in flight. The previous behaviour
  // refused every later turn on that session forever; a stale row is now
  // reclaimed before refusal so the session survives.
  test("a running row whose updated_at is past the stale window is reclaimed", () => {
    const { store: s, raw, close } = store();
    const first = s.startRun(input())!;
    // Backdate the row's updated_at past the default 10 minute window.
    const longAgo = Date.now() - (RunStore.STALE_WINDOW_MS + 60_000);
    raw.query("UPDATE runs SET updated_at = ? WHERE id = ?").run(longAgo, first.id);
    const second = s.startRun(input());
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
    expect(s.get(first.id)!.status).toBe("unfinished");
    expect(s.get(first.id)!.stoppedBecause).toBe("not_continuable");
    close();
  });

  test("a running row whose deadline is in the past is reclaimed regardless of updated_at", () => {
    const { store: s, raw, close } = store();
    const first = s.startRun(input({ deadlineAt: Date.now() - 1_000 }))!;
    // updated_at is now-ish (just inserted); the deadline alone is enough.
    const second = s.startRun(input());
    expect(second).not.toBeNull();
    expect(s.get(first.id)!.status).toBe("unfinished");
    close();
  });

  test("a running row touched 30 seconds ago is not reclaimed", () => {
    const { store: s, raw, close } = store();
    const first = s.startRun(input())!;
    const thirtySecondsAgo = Date.now() - 30_000;
    raw.query("UPDATE runs SET updated_at = ? WHERE id = ?").run(thirtySecondsAgo, first.id);
    const second = s.startRun(input());
    expect(second).toBeNull();
    expect(s.get(first.id)!.status).toBe("running");
    close();
  });

  test("a non-continuation turn still bumps updated_at (the bug behind the brick)", () => {
    const { store: s, raw, close } = store();
    const run = s.startRun(input())!;
    const initial = s.get(run.id)!.updatedAt;
    // Pause so the new write is distinguishable at millisecond resolution.
    Bun.sleepSync(5);
    s.appendTurn({
      runId: run.id, startedAt: 1, durationMs: 1, outcome: "completed",
      toolCalls: 0, continuation: false, replan: false, tokens: 0,
      filesChanged: 0, todosClosed: 0, doneWhenPass: null,
    });
    expect(s.get(run.id)!.updatedAt).toBeGreaterThan(initial);
    close();
  });

  test("the stale window honours CINDERPAW_RUN_STALE_MS", () => {
    const { store: s, raw, close } = store();
    const prev = process.env.CINDERPAW_RUN_STALE_MS;
    try {
      process.env.CINDERPAW_RUN_STALE_MS = "1000";
      const first = s.startRun(input())!;
      // 2 seconds old, beyond the 1s override but well inside the default.
      raw.query("UPDATE runs SET updated_at = ? WHERE id = ?").run(Date.now() - 2_000, first.id);
      const second = s.startRun(input());
      expect(second).not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CINDERPAW_RUN_STALE_MS;
      else process.env.CINDERPAW_RUN_STALE_MS = prev;
    }
    close();
  });
});
