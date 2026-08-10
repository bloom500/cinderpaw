/**
 * Unattended execution, safety points, done_when, and the digest.
 *
 * The failure these cover: a scheduled task that ran out of turn budget
 * half-way was reported as a success, its retry streak reset, its partial
 * output delivered as the answer — and nothing recorded that the work was
 * never finished.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnattended, type RunTurn } from "../src/core/unattended.ts";
import { createSafetyPoint, changedSince } from "../src/core/safety-point.ts";
import { CHEAP_CHECKS, parseDoneWhen, verifyDoneWhen } from "../src/cron/done-when.ts";
import { renderDigest } from "../src/core/digest.ts";
import type { TurnOutcome, TurnResult } from "../src/core/agent-loop.ts";

const noop = () => {};

/** A turn function that ends with a scripted sequence of outcomes. */
function scripted(outcomes: TurnOutcome[]): { run: RunTurn; prompts: string[]; ids: string[] } {
  const prompts: string[] = [];
  const ids: string[] = [];
  const run: RunTurn = async (text, messageId): Promise<TurnResult> => {
    prompts.push(text);
    ids.push(messageId);
    const outcome = outcomes[prompts.length - 1] ?? "completed";
    return {
      text: `turn ${prompts.length} (${outcome})`,
      outcome,
      toolCallCount: 3,
      incomplete: outcome === "out_of_time" || outcome === "ceiling",
    };
  };
  return { run, prompts, ids };
}

describe("runUnattended", () => {
  const prev = process.env.FERAL_UNATTENDED_CONTINUATIONS;
  beforeEach(() => {
    process.env.FERAL_UNATTENDED_CONTINUATIONS = "3";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.FERAL_UNATTENDED_CONTINUATIONS;
    else process.env.FERAL_UNATTENDED_CONTINUATIONS = prev;
  });

  test("a task that completes first time runs exactly one turn", async () => {
    const agent = scripted(["completed"]);
    const run = await runUnattended(agent.run, "do the thing", "m");

    expect(agent.prompts).toHaveLength(1);
    expect(run.finished).toBe(true);
    expect(run.stoppedBecause).toBe("completed");
    // A finished run is delivered clean — no warning banner.
    expect(run.text).not.toContain("Not finished");
  });

  test("out of time is continued, not reported as done", async () => {
    const agent = scripted(["out_of_time", "out_of_time", "completed"]);
    const run = await runUnattended(agent.run, "do the thing", "m");

    expect(agent.prompts).toHaveLength(3);
    expect(run.finished).toBe(true);
    expect(run.turns.filter((t) => t.continuation)).toHaveLength(2);
    // The continuation must forbid a restart: re-running side effects on an
    // unattended run is worse than stopping.
    expect(agent.prompts[1]).toContain("Do NOT start over");
    expect(agent.prompts[1]).toContain("no human is watching");
  });

  test("a stuck turn gets one turn to find another way in", async () => {
    const agent = scripted(["stuck", "completed"]);
    const run = await runUnattended(agent.run, "do the thing", "m");

    expect(agent.prompts).toHaveLength(2);
    expect(run.finished).toBe(true);
    expect(run.turns[1]?.replan).toBe(true);
    // The replan prompt must not read like a continuation: "pick up where you
    // stopped" points at the approach that was just refuted.
    expect(agent.prompts[1]).not.toContain("Pick up exactly where you stopped");
    expect(agent.prompts[1]).toContain("refuted");
    expect(agent.prompts[1]).toContain("DIFFERENT approach");
    // Giving up must stay available, or the model invents an approach and runs
    // it unattended for another hour.
    expect(agent.prompts[1]).toContain("stop");
  });

  test("the replan happens once, not once per stuck turn", async () => {
    const agent = scripted(["stuck", "stuck", "stuck", "stuck"]);
    const run = await runUnattended(agent.run, "do the thing", "m");

    expect(agent.prompts).toHaveLength(2);
    expect(run.finished).toBe(false);
    expect(run.outcome).toBe("stuck");
    expect(run.turns.filter((t) => t.replan)).toHaveLength(1);
    // The banner has to say the alternative was already tried — that decides
    // whether the reader's next move is "retry" or "this needs me".
    expect(run.text).toContain("did not work either");
  });

  test("a stuck turn with no budget left is not replanned", async () => {
    process.env.FERAL_UNATTENDED_CONTINUATIONS = "0";
    const agent = scripted(["stuck"]);
    const run = await runUnattended(agent.run, "do the thing", "m");

    expect(agent.prompts).toHaveLength(1);
    expect(run.finished).toBe(false);
    expect(run.text).not.toContain("did not work either");
  });

  test("the configured mission deadline bounds a run nobody passed one for", async () => {
    process.env.FERAL_UNATTENDED_CONTINUATIONS = "10";
    process.env.FERAL_MISSION_DEADLINE_MS = "1";
    try {
      // The turn has to consume real wall clock: the deadline is checked
      // between turns, and a scripted turn that returns in under a millisecond
      // never advances Date.now() past it.
      const agent = scripted(["out_of_time", "out_of_time", "out_of_time"]);
      const slow: RunTurn = async (text, id) => {
        await new Promise((r) => setTimeout(r, 5));
        return agent.run(text, id);
      };
      const run = await runUnattended(slow, "do the thing", "m");

      // Dispatch and the connectors pass no deadline; before the config default
      // they were bounded only by the continuation counter, which cannot
      // express "stop at 6am".
      expect(agent.prompts).toHaveLength(1);
      expect(run.stoppedBecause).toBe("deadline");
      expect(run.finished).toBe(false);
    } finally {
      delete process.env.FERAL_MISSION_DEADLINE_MS;
    }
  });

  test("an explicit deadline still wins over the configured one", async () => {
    process.env.FERAL_MISSION_DEADLINE_MS = "1";
    try {
      const agent = scripted(["out_of_time", "completed"]);
      const run = await runUnattended(agent.run, "do the thing", "m", {
        deadlineMs: 60_000,
      });

      expect(agent.prompts).toHaveLength(2);
      expect(run.finished).toBe(true);
    } finally {
      delete process.env.FERAL_MISSION_DEADLINE_MS;
    }
  });

  test("exhausting the continuation budget reports UNFINISHED", async () => {
    const agent = scripted(["out_of_time", "out_of_time", "out_of_time", "out_of_time"]);
    const run = await runUnattended(agent.run, "big task", "m");

    // 1 initial + 3 continuations, then it stops.
    expect(agent.prompts).toHaveLength(4);
    expect(run.finished).toBe(false);
    expect(run.stoppedBecause).toBe("continuation_budget");
    // The banner leads, because a phone notification shows the first line only.
    expect(run.text.split("\n")[0]).toContain("Not finished");
  });

  test("a stuck run is replanned once and then NOT continued", async () => {
    const agent = scripted(["stuck", "stuck"]);
    const run = await runUnattended(agent.run, "task", "m");

    // This test used to assert one turn: a stuck outcome ended the run outright,
    // because continuing it buys nothing but tokens. That is still true of a
    // CONTINUATION — and it is why the replan is a different prompt rather than
    // a higher continuation budget. One alternative, then stop.
    expect(agent.prompts).toHaveLength(2);
    expect(run.finished).toBe(false);
    expect(run.stoppedBecause).toBe("not_continuable");
  });

  test("continuations can be disabled entirely", async () => {
    process.env.FERAL_UNATTENDED_CONTINUATIONS = "0";
    const agent = scripted(["out_of_time", "completed"]);
    const run = await runUnattended(agent.run, "task", "m");

    expect(agent.prompts).toHaveLength(1);
    expect(run.finished).toBe(false);
  });

  test("the deadline stops a run before it starts a turn it cannot finish", async () => {
    const agent = scripted(["out_of_time", "out_of_time", "out_of_time", "completed"]);
    const run = await runUnattended(agent.run, "task", "m", { deadlineMs: 0 });

    expect(agent.prompts).toHaveLength(1);
    expect(run.stoppedBecause).toBe("deadline");
    expect(run.finished).toBe(false);
  });

  // ── Turn recording ────────────────────────────────────────────────────────
  // The loop's own `turns` array dies with the process. A recorder is how a run
  // stays auditable after the thing that ran it is gone.

  test("every turn is handed to the recorder, in order, with its outcome", async () => {
    const seen: Array<{ outcome: TurnOutcome; continuation: boolean; startedAt: number }> = [];
    const agent = scripted(["out_of_time", "out_of_time", "completed"]);
    const run = await runUnattended(agent.run, "task", "m", {
      recorder: {
        record: (t) => {
          seen.push({ outcome: t.outcome, continuation: t.continuation, startedAt: t.startedAt });
        },
      },
    });

    expect(run.turns).toHaveLength(3);
    expect(seen.map((s) => s.outcome)).toEqual(["out_of_time", "out_of_time", "completed"]);
    expect(seen.map((s) => s.continuation)).toEqual([false, true, true]);
    // A startedAt of 0 would make every duration in the report a lie.
    expect(seen.every((s) => s.startedAt > 0)).toBe(true);
  });

  test("the recorder is told which turn was the replan", async () => {
    // `replan` latches `replan_used` on the row, which is what stops the single
    // retry being spent again after a restart. If it never reaches the recorder,
    // a resumed run gets a fresh replan every time it comes back.
    const seen: Array<{ outcome: TurnOutcome; replan?: boolean }> = [];
    const agent = scripted(["stuck", "completed"]);
    await runUnattended(agent.run, "task", "m", {
      recorder: { record: (t) => { seen.push({ outcome: t.outcome, replan: t.replan }); } },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.replan).toBeUndefined();
    expect(seen[1]!.replan).toBe(true);
  });

  test("a recorder that throws does not kill the run", async () => {
    // Telemetry is never allowed to be the reason unattended work stops.
    const agent = scripted(["completed"]);
    const run = await runUnattended(agent.run, "task", "m", {
      recorder: { record: () => { throw new Error("disk full"); } },
    });
    expect(run.finished).toBe(true);
  });

  test("a recorder whose promise rejects does not kill the run either", async () => {
    // The sync throw and the async rejection are different code paths, and the
    // real recorder writes to SQLite behind an await.
    const agent = scripted(["completed"]);
    const run = await runUnattended(agent.run, "task", "m", {
      recorder: { record: () => Promise.reject(new Error("db locked")) },
    });
    expect(run.finished).toBe(true);
  });

  test("no recorder means no behaviour change at all", async () => {
    const agent = scripted(["completed"]);
    const run = await runUnattended(agent.run, "task", "m");
    expect(run.finished).toBe(true);
    expect(run.turns).toHaveLength(1);
  });

  // ── Stall guard ──────────────────────────────────────────────────────────
  // The same "changed nothing, closed nothing" evidence `decideResume` reads at
  // boot, now reachable at the turn boundary too — a live run can be stopped
  // instead of spinning on a refuted attempt until the deadline.

  test("a stalled run replans once before giving up", async () => {
    const prompts: string[] = [];
    let stalled = false;
    const result = await runUnattended(
      async (prompt) => {
        prompts.push(prompt);
        stalled = true; // every turn from here on looks dead
        return { text: "still going", outcome: "out_of_time" as TurnOutcome, incomplete: true, toolCallCount: 1 };
      },
      "do the thing",
      "msg1",
      { stalled: () => stalled },
    );
    // One replan attempt, then a stop — not an endless retry.
    expect(prompts.filter((p) => p.includes("DIFFERENT approach"))).toHaveLength(1);
    expect(result.stoppedBecause).toBe("no_progress");
    expect(result.finished).toBe(false);
  });

  test("a run that is making progress is never stopped by the guard", async () => {
    let calls = 0;
    const result = await runUnattended(
      async () => {
        calls++;
        return {
          text: "done",
          outcome: (calls >= 2 ? "completed" : "out_of_time") as TurnOutcome,
          incomplete: calls < 2,
          toolCallCount: 1,
        };
      },
      "do the thing",
      "msg1",
      { stalled: () => false },
    );
    expect(result.stoppedBecause).toBe("completed");
  });

  test("with no stalled callback the loop behaves exactly as before", async () => {
    const result = await runUnattended(
      async () => ({ text: "ok", outcome: "completed" as TurnOutcome, incomplete: false, toolCallCount: 0 }),
      "task",
      "msg1",
      {},
    );
    expect(result.stoppedBecause).toBe("completed");
  });
});

describe("verifyDoneWhen kinds filter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "feral-kinds-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a command check is skipped when only cheap kinds are asked for", async () => {
    // Not "failed" — not evaluated. Reporting a skipped check as a failure would
    // mark every mid-run turn as broken.
    const filtered = await verifyDoneWhen({ kind: "command", value: "exit 1" }, null, CHEAP_CHECKS);
    expect(filtered.checked).toBe(false);
    expect(filtered.passed).toBe(true);
    // And it must not claim nothing was declared — an assertion exists, it just
    // has not run yet. Those two read very differently in a report.
    expect(filtered.detail).toContain("not evaluated this turn");
    expect(filtered.detail).not.toContain("no done_when declared");
  });

  test("a cheap check still runs under the same filter, and can fail", async () => {
    await writeFile(join(dir, "out.txt"), "hello");

    const pass = await verifyDoneWhen({ kind: "file_exists", path: "out.txt" }, dir, CHEAP_CHECKS);
    expect(pass.checked).toBe(true);
    expect(pass.passed).toBe(true);

    const fail = await verifyDoneWhen({ kind: "file_exists", path: "nope.txt" }, dir, CHEAP_CHECKS);
    expect(fail.checked).toBe(true);
    expect(fail.passed).toBe(false);
  });

  test("with no filter, a command check runs as it always did", async () => {
    const ok = await verifyDoneWhen({ kind: "command", value: "exit 0" }, null);
    expect(ok.checked).toBe(true);
    expect(ok.passed).toBe(true);
  });

  test("an empty filter evaluates nothing — it is not read as 'no filter'", async () => {
    // `kinds && !kinds.includes(...)` must treat [] as "allow none". An empty
    // array is falsy nowhere in JS, so this is a real distinction, not a
    // theoretical one.
    const none = await verifyDoneWhen({ kind: "file_exists", path: "nope.txt" }, dir, []);
    expect(none.checked).toBe(false);
  });
});

describe("done_when", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "feral-donewhen-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("no assertion means unverified, not verified", async () => {
    const check = await verifyDoneWhen(null, dir);
    expect(check.passed).toBe(true);
    expect(check.checked).toBe(false);
    expect(check.detail).toContain("unverified");
  });

  test("file_exists passes and fails on the real filesystem", async () => {
    await writeFile(join(dir, "report.md"), "hello", "utf8");
    const hit = await verifyDoneWhen({ kind: "file_exists", path: "report.md" }, dir);
    expect(hit.passed).toBe(true);
    expect(hit.checked).toBe(true);

    const miss = await verifyDoneWhen({ kind: "file_exists", path: "absent.md" }, dir);
    expect(miss.passed).toBe(false);
    expect(miss.detail).toContain("does not exist");
  });

  test("file_contains checks the content, not just the path", async () => {
    await writeFile(join(dir, "out.txt"), "total: 42 items", "utf8");
    expect((await verifyDoneWhen({ kind: "file_contains", path: "out.txt", value: "42" }, dir)).passed).toBe(true);
    expect((await verifyDoneWhen({ kind: "file_contains", path: "out.txt", value: "99" }, dir)).passed).toBe(false);
    // A missing file fails the check rather than throwing.
    expect((await verifyDoneWhen({ kind: "file_contains", path: "nope.txt", value: "x" }, dir)).passed).toBe(false);
  });

  test("command asserts on the exit code", async () => {
    const ok = await verifyDoneWhen({ kind: "command", value: "exit 0" }, dir);
    expect(ok.passed).toBe(true);
    const bad = await verifyDoneWhen({ kind: "command", value: "exit 3" }, dir);
    expect(bad.passed).toBe(false);
    expect(bad.detail).toContain("exited 3");
  });

  test("a malformed spec is dropped, not stored as a check that always fails", () => {
    expect(parseDoneWhen(null)).toBeNull();
    expect(parseDoneWhen({ kind: "nonsense" })).toBeNull();
    expect(parseDoneWhen({ kind: "file_exists" })).toBeNull(); // no path
    expect(parseDoneWhen({ kind: "command" })).toBeNull(); // no command
    expect(parseDoneWhen({ kind: "file_exists", path: "x" })).toEqual({
      kind: "file_exists",
      path: "x",
      value: undefined,
      timeoutMs: undefined,
    });
  });
});

describe("safety point", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "feral-safety-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("captures what an unattended run changed, and how to undo it", async () => {
    await writeFile(join(dir, "keep.txt"), "original\n", "utf8");
    await writeFile(join(dir, "doomed.txt"), "delete me\n", "utf8");

    const point = await createSafetyPoint("test-run", noop, dir);
    // Requires git on PATH. Where it is absent the feature degrades rather
    // than failing, and the digest says so — assert that path instead.
    if (!point) {
      const none = await changedSince(null);
      expect(none.available).toBe(false);
      expect(none.reason).toBeTruthy();
      return;
    }

    // Simulate the agent working: modify, create, delete.
    await writeFile(join(dir, "keep.txt"), "rewritten by the agent\n", "utf8");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "new.txt"), "brand new\n", "utf8");
    await rm(join(dir, "doomed.txt"));

    const changes = await changedSince(point, noop);
    expect(changes.available).toBe(true);

    const byPath = new Map(changes.files.map((f) => [f.path, f.status]));
    expect(byPath.get("keep.txt")).toBe("M");
    expect(byPath.get("doomed.txt")).toBe("D");
    // A newly created file is the common case and is only visible because the
    // diff is snapshot-to-snapshot rather than commit-to-worktree.
    expect(byPath.get("sub/new.txt")).toBe("A");

    // The undo path is offered, and review comes before the destructive command.
    expect(changes.restoreHint).toBeTruthy();
    expect(changes.restoreHint!.indexOf("diff")).toBeLessThan(
      changes.restoreHint!.indexOf("checkout"),
    );

    // The project tree stays clean: the shadow repo lives under ~/.feral.
    expect(point.gitDir).toBeTruthy();
    expect(point.gitDir!).not.toStartWith(dir);
  });

  test("a run that changes nothing is distinguishable from an untracked one", async () => {
    await writeFile(join(dir, "a.txt"), "unchanged\n", "utf8");
    const point = await createSafetyPoint("test-run", noop, dir);
    if (!point) return; // no git — covered above

    const changes = await changedSince(point, noop);
    expect(changes.available).toBe(true);
    expect(changes.files).toHaveLength(0);
    expect(changes.restoreHint).toBeNull();
  });

  test("the home directory is refused as a snapshot root", async () => {
    const point = await createSafetyPoint("test", noop, tmpdir() === "/" ? "/" : require("node:os").homedir());
    expect(point).toBeNull();
  });
});

describe("renderDigest", () => {
  const run = (finished: boolean) => ({
    text: "I updated the report.",
    outcome: (finished ? "completed" : "out_of_time") as TurnOutcome,
    finished,
    turns: [
      { outcome: "out_of_time" as TurnOutcome, toolCalls: 20, durationMs: 60_000, continuation: false },
      { outcome: (finished ? "completed" : "out_of_time") as TurnOutcome, toolCalls: 7, durationMs: 30_000, continuation: true },
    ],
    stoppedBecause: (finished ? "completed" : "continuation_budget") as const,
  });

  const noChanges = { available: true, files: [], insertions: 0, deletions: 0, restoreHint: null };

  test("the verdict is the first line", () => {
    const done = renderDigest(run(true), noChanges, { passed: true, checked: true, detail: "verified: build passed" }, null);
    expect(done.split("\n")[0]).toContain("Done");

    const notDone = renderDigest(run(false), noChanges, { passed: true, checked: false, detail: "unverified" }, null);
    expect(notDone.split("\n")[0]).toContain("Not finished");
  });

  test("agent says done + check fails is called out explicitly", () => {
    const out = renderDigest(
      run(true),
      noChanges,
      { passed: false, checked: true, detail: "FAILED: report.md does not exist" },
      null,
    );
    expect(out.split("\n")[0]).toContain("Reported done, but the check failed");
    expect(out).toContain("report.md does not exist");
  });

  test("changed files and the undo command are included", () => {
    const changes = {
      available: true,
      files: [
        { status: "M", path: "src/app.ts" },
        { status: "A", path: "src/new.ts" },
      ],
      insertions: 40,
      deletions: 3,
      restoreHint: "git diff abc123   # review\ngit checkout abc123 -- .   # undo everything above",
    };
    const out = renderDigest(run(true), changes, { passed: true, checked: false, detail: "unverified" }, null);
    expect(out).toContain("modified `src/app.ts`");
    expect(out).toContain("added `src/new.ts`");
    expect(out).toContain("+40/-3");
    expect(out).toContain("git checkout abc123");
  });

  test("untracked changes never read as 'nothing changed'", () => {
    const out = renderDigest(
      run(true),
      { available: false, files: [], insertions: 0, deletions: 0, restoreHint: null, reason: "git unavailable" },
      { passed: true, checked: false, detail: "unverified" },
      null,
    );
    expect(out).toContain("not tracked");
    expect(out).not.toContain("**Files changed:** none");
  });

  test("effort and continuation count are reported", () => {
    const out = renderDigest(run(false), noChanges, { passed: true, checked: false, detail: "unverified" }, null);
    expect(out).toContain("2 turns");
    expect(out).toContain("1 automatic continuation");
    expect(out).toContain("27 actions");
    expect(out).toContain("FERAL_UNATTENDED_CONTINUATIONS");
    // The agent's own words come last.
    expect(out.trimEnd()).toEndWith("I updated the report.");
  });
});
