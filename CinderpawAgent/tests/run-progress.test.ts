/**
 * Progress is what changed on disk, not what the model said.
 *
 * A turn that reports success and wrote nothing looked identical to one that
 * advanced. The safety point is already durable — orphan git commits under
 * `refs/feral/safety/`, or a shadow git dir for a workspace that is not a repo —
 * so the evidence is available at any moment, including after the process that
 * started the run has died. What was missing is the way back: `changedSince`
 * takes the SafetyPoint OBJECT, and after a restart the object is gone.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSafetyPoint,
  changedSince,
  changeFingerprint,
  safetyPointFrom,
  safetyPointsFrom,
  createSafetyPoints,
  safetyColumns,
  type SafetyPoint,
} from "../src/core/safety-point.ts";

/** A throwaway git repository with one committed file. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feral-progress-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
  Bun.spawnSync(
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"],
    { cwd: dir },
  );
  return dir;
}

/** A plain directory — no git — so the shadow-repo path is exercised. */
async function plainDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feral-progress-plain-"));
  await writeFile(join(dir, "notes.md"), "# notes\n");
  return dir;
}

/** Exactly the columns a run row persists, and nothing else. */
function asPersisted(point: SafetyPoint) {
  return {
    id: "run-1",
    createdAt: point.createdAt,
    safetyRoot: point.root,
    safetyBefore: point.before,
    safetyGitDir: point.gitDir,
  };
}

describe("safetyPointFrom", () => {
  test("a point rebuilt from persisted columns sees the same changes as the original", async () => {
    const dir = await repo();
    const point = await createSafetyPoint("test/run", () => {}, dir);
    expect(point).not.toBeNull();

    await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n");

    // The object the run started with…
    const direct = await changedSince(point);
    // …and one rebuilt from what a row would hold after a restart.
    const afterRestart = await changedSince(safetyPointFrom(asPersisted(point!)));

    expect(direct.available).toBe(true);
    expect(afterRestart.available).toBe(true);
    expect(afterRestart.files.map((f) => f.path).sort()).toEqual(
      direct.files.map((f) => f.path).sort(),
    );
    expect(afterRestart.files.length).toBeGreaterThan(0);
  });

  test("a turn that wrote nothing reports zero changed files", async () => {
    const dir = await repo();
    const point = await createSafetyPoint("test/run", () => {}, dir);
    const summary = await changedSince(safetyPointFrom(asPersisted(point!)));
    expect(summary.available).toBe(true);
    expect(summary.files).toHaveLength(0);
  });

  test("a workspace that is not a git repo rebuilds through its shadow git dir", async () => {
    // The only reason safety_git_dir is a column: without it the rebuilt point
    // would look in the project for a git dir that was deliberately never put
    // there, and report "unavailable" for a run that is perfectly trackable.
    const dir = await plainDir();
    const point = await createSafetyPoint("test/plain", () => {}, dir);
    expect(point).not.toBeNull();
    expect(point!.gitDir).not.toBeNull();

    await writeFile(join(dir, "extra.md"), "# extra\n");

    const rebuilt = safetyPointFrom(asPersisted(point!));
    expect(rebuilt!.gitDir).toBe(point!.gitDir);
    const summary = await changedSince(rebuilt);
    expect(summary.available).toBe(true);
    expect(summary.files.map((f) => f.path)).toContain("extra.md");
  });

  test("a run with no snapshot rebuilds to null, and null is not 'nothing changed'", async () => {
    const rebuilt = safetyPointFrom({
      id: "run-1",
      createdAt: 1,
      safetyRoot: null,
      safetyBefore: null,
      safetyGitDir: null,
    });
    expect(rebuilt).toBeNull();

    const summary = await changedSince(rebuilt);
    // The existing contract, which this must not weaken: unavailable, with a
    // reason — never a silent zero that reads as "it changed nothing".
    expect(summary.available).toBe(false);
    expect(summary.reason).toBeTruthy();
    expect(summary.files).toHaveLength(0);
  });

  test("a half-written row (root but no commit) also rebuilds to null", async () => {
    // Fail toward "unavailable, and here is why" rather than toward a point that
    // git will reject at diff time with something unreadable.
    const rebuilt = safetyPointFrom({
      id: "run-1",
      createdAt: 1,
      safetyRoot: "/some/workspace",
      safetyBefore: null,
      safetyGitDir: null,
    });
    expect(rebuilt).toBeNull();
  });
});

describe("changeFingerprint", () => {
  test("a turn that changed nothing stamps identically to the turn before it", async () => {
    // This is what makes "did THIS turn do anything" answerable at all:
    // changedSince is cumulative, so comparing its file COUNT against zero would
    // never fire once a run had changed anything at all.
    const dir = await repo();
    const point = await createSafetyPoint("test/run", () => {}, dir);
    await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n");

    const afterWork = changeFingerprint(await changedSince(point));
    const afterIdleTurn = changeFingerprint(await changedSince(point));
    expect(afterIdleTurn).toBe(afterWork);
  });

  test("editing the same file again moves the stamp, even though the count does not", async () => {
    const dir = await repo();
    const point = await createSafetyPoint("test/run", () => {}, dir);

    await writeFile(join(dir, "src", "a.ts"), "export const a = 2;\n");
    const one = await changedSince(point);
    const first = changeFingerprint(one);

    await writeFile(join(dir, "src", "a.ts"), "export const a = 2;\nexport const c = 3;\n");
    const two = await changedSince(point);

    expect(two.files).toHaveLength(one.files.length); // same count…
    expect(changeFingerprint(two)).not.toBe(first); // …different stamp
  });

  test("a new file moves the stamp", async () => {
    const dir = await repo();
    const point = await createSafetyPoint("test/run", () => {}, dir);
    const before = changeFingerprint(await changedSince(point));
    await writeFile(join(dir, "src", "c.ts"), "export const c = 3;\n");
    expect(changeFingerprint(await changedSince(point))).not.toBe(before);
  });

  test("an unmeasurable workspace never stamps as unchanged", async () => {
    // "We could not look" must not be recorded as "nothing happened" — that is
    // the same lie changedSince's `available` flag exists to prevent.
    const unavailable = await changedSince(null);
    expect(unavailable.available).toBe(false);
    expect(changeFingerprint(unavailable)).not.toBe(changeFingerprint(unavailable));
  });
});

describe("safetyPointFrom edge cases", () => {
  test("a row with a commit but no root also rebuilds to null", () => {
    // Both halves are required; either one alone is a half-written row.
    expect(
      safetyPointFrom({
        id: "run-1",
        createdAt: 1,
        safetyRoot: null,
        safetyBefore: "abc123",
        safetyGitDir: null,
      }),
    ).toBeNull();
  });
});

/**
 * Every workspace root, not just the first.
 *
 * Found live: the agent was told "the workspace", picked the third configured
 * root (`~/.feral/workspace`) and wrote three files there, while the safety
 * point covered only the first (the repo). The digest reported zero files, and
 * — worse — `filesChanged: 0` on every turn is exactly the signal
 * `decideResume` reads as "the last attempt achieved nothing", so a healthy
 * resumed run would have been abandoned as `no_progress` while it was working.
 *
 * The snapshot has to cover everywhere the agent may write, because
 * "unmeasured" and "unmoved" are recorded in the same column.
 */
describe("safety points across every workspace root", () => {
  test("a file written in a root other than the first is still seen", async () => {
    const first = await repo();
    const second = await plainDir();

    const points = await createSafetyPoints("test/run", () => {}, [first, second]);
    expect(points).toHaveLength(2);

    await writeFile(join(second, "only-here.md"), "written in the second root\n");

    const summary = await changedSince(points);
    expect(summary.available).toBe(true);
    expect(summary.files.map((f) => f.path).join(" ")).toContain("only-here.md");
  });

  test("the roots survive a restart through the persisted columns", async () => {
    const first = await repo();
    const second = await plainDir();
    const points = await createSafetyPoints("test/run", () => {}, [first, second]);
    const cols = safetyColumns(points);

    await writeFile(join(second, "after-restart.md"), "still visible\n");

    const rebuilt = safetyPointsFrom({
      id: "run-1",
      createdAt: points[0]!.createdAt,
      safetyRoot: cols.root,
      safetyBefore: cols.before,
      safetyGitDir: cols.gitDir,
    });
    expect(rebuilt).toHaveLength(2);
    const summary = await changedSince(rebuilt);
    expect(summary.files.map((f) => f.path).join(" ")).toContain("after-restart.md");
  });

  test("no snapshot anywhere is still 'unavailable', never a silent zero", async () => {
    const summary = await changedSince([]);
    expect(summary.available).toBe(false);
    expect(summary.reason).toBeTruthy();
    expect(summary.files).toHaveLength(0);
  });
});
