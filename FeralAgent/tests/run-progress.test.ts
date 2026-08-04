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
  safetyPointFrom,
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
    // Fail toward "unavailable, and here is why" rather than toward a point
    // that git will reject at diff time with something unreadable.
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
