/**
 * Atomic file writes: temp file in the same directory, fsync, rename.
 *
 * A plain `writeFile` truncates the target first, so a crash, an OOM kill or a
 * pulled plug mid-write leaves a half-file on disk — and the half that was lost
 * is the user's, not ours. `edit_file` is the worst case: it reads 800 lines,
 * rewrites them, and a death at byte 400 destroys work nobody asked us to
 * touch. Rename is atomic on POSIX and `MoveFileEx(REPLACE_EXISTING)` on
 * Windows, so a reader sees either the whole old file or the whole new one.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * A counter, not just pid + clock. `Date.now()` has millisecond resolution, so
 * two async writes to the same file that begin in the same millisecond used to
 * derive the SAME temp path: one renamed it away and the other renamed a file
 * that was no longer there. Measured at 53 failures out of 64 concurrent
 * writers — the common case, not a rare interleaving. pid keeps it unique
 * across processes; the counter keeps it unique inside one.
 */
let tmpCounter = 0;

function tmpPathFor(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${Date.now()}.${tmpCounter++}`;
}

// ponytail: write-temp + fsync + rename. Atomic on POSIX; best-effort on Windows.
export function atomicWriteFileSync(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = tmpPathFor(filePath);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * One writer at a time per file, within this process.
 *
 * Retrying a lost rename treats the symptom; the cause is N writers racing for
 * one destination. Sub-agents run tool calls in parallel, so `write_file` twice
 * on one path is ordinary. Queueing per path makes the second write wait for
 * the first instead of fighting it — last writer wins, which is what a caller
 * awaiting a write already believes. Cross-process contention is still handled
 * by the rename retry below.
 *
 * The map entry is dropped when its chain drains, so a long-lived process does
 * not accumulate one promise per file it has ever touched.
 */
const writeChains = new Map<string, Promise<void>>();

/** Async twin of {@link atomicWriteFileSync}, for the tool paths that await. */
export function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const key = path.resolve(filePath);
  const prior = writeChains.get(key) ?? Promise.resolve();
  // `.catch` so one failed write does not poison every later write to the file.
  const next = prior.then(
    () => writeOnce(filePath, contents),
    () => writeOnce(filePath, contents),
  );
  const settled = next.finally(() => {
    if (writeChains.get(key) === settled) writeChains.delete(key);
  });
  writeChains.set(key, settled);
  return next;
}

async function writeOnce(filePath: string, contents: string): Promise<void> {
  const fsp = fs.promises;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = tmpPathFor(filePath);
  const handle = await fsp.open(tmp, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Windows only: two renames onto the SAME destination collide, and the loser
 * gets EPERM even though both temp files exist and both are complete. POSIX
 * rename has no such window. Measured: 48 of 64 concurrent writers failed this
 * way with unique temp names, so the retry is what makes the promise ("either
 * the whole old file or the whole new one") true on Windows rather than merely
 * intended.
 *
 * ponytail: fixed short backoff, no jitter. The contention window is a single
 * rename syscall; if this ever needs more than 5 attempts the problem is a
 * writer that holds the file open, and a longer sleep would only hide it.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const attempts = 5;
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!retryable || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 2 * (i + 1)));
    }
  }
}
