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

function tmpPathFor(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${Date.now()}`;
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

/** Async twin of {@link atomicWriteFileSync}, for the tool paths that await. */
export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
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
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}
