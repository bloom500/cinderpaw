/**
 * A sidecar that is still shutting down holds the memory lock for a while
 * after `cinderpaw stop` returns. Seen 25 Sep: the next start hit the lock
 * five times and the host gave up. Boot now waits for a live predecessor.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForWriterLock } from "../src/db.ts";

const dirs: string[] = [];
const kids: { kill(): void }[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lockedBy(pid: number): { db: string; lock: string } {
  const dir = mkdtempSync(join(tmpdir(), "cp-lock-"));
  dirs.push(dir);
  const lock = join(dir, ".writer.lock");
  writeFileSync(lock, `${pid}\n`);
  return { db: join(dir, "cinderpaw.db"), lock };
}

function livingProcess(): number {
  const kid = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 20000)"]);
  kids.push(kid);
  return kid.pid;
}

test("a dead owner's lock is not waited for", async () => {
  const { db } = lockedBy(999_999_9);
  const t = Date.now();
  await waitForWriterLock(db, 5_000);
  expect(Date.now() - t).toBeLessThan(400);
});

test("a live predecessor is waited for until it lets go", async () => {
  const { db, lock } = lockedBy(livingProcess());
  setTimeout(() => unlinkSync(lock), 700);
  const t = Date.now();
  await waitForWriterLock(db, 10_000);
  const waited = Date.now() - t;
  expect(waited).toBeGreaterThanOrEqual(600);
  expect(waited).toBeLessThan(3_000);
});

test("the wait ends at its limit, and openDatabase then decides", async () => {
  const { db } = lockedBy(livingProcess());
  const t = Date.now();
  await waitForWriterLock(db, 800);
  expect(Date.now() - t).toBeGreaterThanOrEqual(700);
});
