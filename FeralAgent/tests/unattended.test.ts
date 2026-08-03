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
import { parseDoneWhen, verifyDoneWhen } from "../src/cron/done-when.ts";
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

  test("a stuck run is NOT continued — repeating it cannot help", async () => {
    const agent = scripted(["stuck"]);
    const run = await runUnattended(agent.run, "task", "m");

    expect(agent.prompts).toHaveLength(1);
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
