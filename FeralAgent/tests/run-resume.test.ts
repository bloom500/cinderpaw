/**
 * What a boot does with a run whose process never came back.
 *
 * Four outcomes, and only one of them is "carry on". The other three all end in
 * a delivered report, because a run that died in silence is the failure this
 * whole feature exists to remove — "give up quietly" is not one of the options.
 */

import { describe, expect, test } from "bun:test";
import { decideResume, DEFAULT_MAX_RESUMES, madeNoProgress, STALL_TURNS } from "../src/core/run-resume.ts";
import type { RunRow, TurnRow } from "../src/core/run-store.ts";

const NOW = 1_800_000_000_000;

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "r1",
    sessionId: "discord:c1:u1",
    mission: "add a --json flag",
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    deadlineAt: null,
    continuationsUsed: 1,
    continuationBudget: 4,
    replanUsed: false,
    safetyRoot: "/w",
    safetyBefore: "abc",
    safetyGitDir: null,
    doneWhen: null,
    delivery: null,
    status: "running",
    stoppedBecause: null,
    resumes: 0,
    lastResumeSeq: null,
    ...over,
  };
}

function turn(seq: number, over: Partial<TurnRow> = {}): TurnRow {
  return {
    runId: "r1",
    seq,
    startedAt: NOW - 1000,
    durationMs: 100,
    outcome: "out_of_time",
    toolCalls: 1,
    continuation: seq > 1,
    replan: false,
    tokens: 10,
    filesChanged: 0,
    todosClosed: 0,
    doneWhenPass: null,
    ...over,
  };
}

describe("decideResume", () => {
  test("a run whose process died inside its deadline is resumed", () => {
    const d = decideResume(run({ deadlineAt: NOW + 3_600_000 }), [turn(1)], NOW);
    expect(d.action).toBe("resume");
  });

  test("a run with no deadline at all is resumed", () => {
    expect(decideResume(run(), [turn(1)], NOW).action).toBe("resume");
  });

  test("a past deadline gives up as unfinished, and says the process died", () => {
    const d = decideResume(run({ deadlineAt: NOW - 1 }), [turn(1)], NOW);
    expect(d).toMatchObject({ action: "give_up", status: "unfinished", reason: "process_died" });
    expect((d as { why: string }).why).toContain("deadline");
  });

  test("a deadline exactly now is past, not still open", () => {
    // <= rather than <: a run whose clock ran out at this instant has no time
    // left to do anything with.
    const d = decideResume(run({ deadlineAt: NOW }), [turn(1)], NOW);
    expect(d.action).toBe("give_up");
  });

  test("the resume cap stops the loop and asks for a human", () => {
    const d = decideResume(run({ resumes: DEFAULT_MAX_RESUMES }), [turn(1)], NOW);
    expect(d).toMatchObject({ action: "give_up", status: "needs_attention", reason: "resume_cap" });
  });

  test("one resume below the cap is still resumed", () => {
    const d = decideResume(run({ resumes: DEFAULT_MAX_RESUMES - 1, lastResumeSeq: 1 }), [
      turn(1, { filesChanged: 1 }),
    ], NOW);
    expect(d.action).toBe("resume");
  });

  test("a resume that produced no artifacts is not resumed again", () => {
    // The crash-loop guard: dying on the same step all night, burning tokens and
    // reporting nothing, is worse than stopping and saying so.
    const turns = [turn(1, { filesChanged: 3 }), turn(2), turn(3)];
    const d = decideResume(run({ resumes: 1, lastResumeSeq: 2 }), turns, NOW);
    expect(d).toMatchObject({ action: "give_up", status: "needs_attention", reason: "no_progress" });
  });

  test("a resume that changed a file is resumed again", () => {
    const turns = [turn(1), turn(2, { filesChanged: 1 })];
    expect(decideResume(run({ resumes: 1, lastResumeSeq: 2 }), turns, NOW).action).toBe("resume");
  });

  test("a resume that only closed a todo counts as progress", () => {
    // Moving a task forward without touching a file is real work — planning,
    // reprioritising, marking something impossible.
    const turns = [turn(1), turn(2, { todosClosed: 1 })];
    expect(decideResume(run({ resumes: 1, lastResumeSeq: 2 }), turns, NOW).action).toBe("resume");
  });

  test("only turns from the LAST resume count, not the whole run", () => {
    // Work done before the last resume must not vouch for the last resume.
    const turns = [turn(1, { filesChanged: 9 }), turn(2, { filesChanged: 9 }), turn(3), turn(4)];
    const d = decideResume(run({ resumes: 2, lastResumeSeq: 3 }), turns, NOW);
    expect(d).toMatchObject({ reason: "no_progress" });
  });

  test("a run with no snapshot is never declared stalled — unmeasured is not unmoved", () => {
    // Without a safety point, filesChanged is structurally 0 on every turn and
    // says nothing about whether work happened. Judging it would abandon every
    // resumable chat-surface run after one restart. The resume cap still bounds
    // it, so this is not an escape hatch.
    const turns = [turn(1), turn(2), turn(3)];
    const d = decideResume(
      run({ resumes: 1, lastResumeSeq: 2, safetyBefore: null, safetyRoot: null }),
      turns,
      NOW,
    );
    expect(d.action).toBe("resume");
  });

  test("…but the cap still stops an unmeasurable run from looping forever", () => {
    const d = decideResume(
      run({ resumes: DEFAULT_MAX_RESUMES, safetyBefore: null, safetyRoot: null }),
      [turn(1)],
      NOW,
    );
    expect(d).toMatchObject({ action: "give_up", reason: "resume_cap" });
  });

  test("a first crash is not evidence of a loop, even with zero progress", () => {
    // resumes === 0: nothing has been retried yet, so there is no loop to break.
    const d = decideResume(run({ resumes: 0, lastResumeSeq: null }), [turn(1)], NOW);
    expect(d.action).toBe("resume");
  });

  test("a resume that died before producing a single turn is retried, not judged", () => {
    // It never got a chance to fail on its own terms.
    const turns = [turn(1, { filesChanged: 1 })];
    const d = decideResume(run({ resumes: 1, lastResumeSeq: 2 }), turns, NOW);
    expect(d.action).toBe("resume");
  });

  test("a run with no turns at all is resumed — it died before its first turn", () => {
    expect(decideResume(run(), [], NOW).action).toBe("resume");
  });

  test("the deadline is checked before the resume cap, so the reason is the true one", () => {
    const d = decideResume(run({ deadlineAt: NOW - 1, resumes: DEFAULT_MAX_RESUMES }), [turn(1)], NOW);
    expect((d as { reason: string }).reason).toBe("process_died");
  });

  test("a custom cap is honoured", () => {
    expect(decideResume(run({ resumes: 1 }), [turn(1, { filesChanged: 1 })], NOW, 1).action)
      .toBe("give_up");
    expect(decideResume(run({ resumes: 1 }), [turn(1, { filesChanged: 1 })], NOW, 9).action)
      .toBe("resume");
  });

  test("every give_up carries a human-readable why, because it gets delivered", () => {
    const cases: RunRow[] = [
      run({ deadlineAt: NOW - 1 }),
      run({ resumes: DEFAULT_MAX_RESUMES }),
      run({ resumes: 1, lastResumeSeq: 1 }),
    ];
    for (const r of cases) {
      const d = decideResume(r, [turn(1)], NOW);
      expect(d.action).toBe("give_up");
      expect((d as { why: string }).why.length).toBeGreaterThan(20);
    }
  });
});

describe("madeNoProgress", () => {
  function turn(seq: number, filesChanged: number, todosClosed: number): TurnRow {
    return {
      runId: "r", seq, startedAt: 0, durationMs: 1, outcome: "completed",
      toolCalls: 1, continuation: seq > 1, replan: false, tokens: 0,
      filesChanged, todosClosed, doneWhenPass: null,
    };
  }

  test("three turns that changed nothing is a stall", () => {
    expect(madeNoProgress([turn(1, 0, 0), turn(2, 0, 0), turn(3, 0, 0)], 3)).toBe(true);
  });

  test("one changed file anywhere in the window clears it", () => {
    expect(madeNoProgress([turn(1, 0, 0), turn(2, 1, 0), turn(3, 0, 0)], 3)).toBe(false);
  });

  test("a closed todo counts as progress even with no file written", () => {
    expect(madeNoProgress([turn(1, 0, 0), turn(2, 0, 1), turn(3, 0, 0)], 3)).toBe(false);
  });

  test("fewer turns than the window is never a stall — there is not enough evidence yet", () => {
    expect(madeNoProgress([turn(1, 0, 0), turn(2, 0, 0)], 3)).toBe(false);
  });

  test("only the last `count` turns are judged, not the whole run", () => {
    // Real work early, then three dead turns. Still a stall.
    expect(madeNoProgress([turn(1, 5, 2), turn(2, 0, 0), turn(3, 0, 0), turn(4, 0, 0)], 3)).toBe(true);
  });

  test("STALL_TURNS is 3 — one quiet turn is normal work, ten is most of an hour", () => {
    expect(STALL_TURNS).toBe(3);
  });
});
