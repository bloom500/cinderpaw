/**
 * Read ledger — the precondition behind "read before you edit".
 *
 * The agent's prompt tells it to understand the user's GOAL. Nothing told it
 * to understand the CODE, and nothing enforced it: `edit_file` and
 * `write_file` would happily rewrite a file the agent had never opened, using
 * whatever it assumed the contents were. On a walk-away run that is the single
 * most expensive failure mode, because it is silent — the edit "succeeds", the
 * file is now wrong, and the damage surfaces many steps later when the
 * original context is gone.
 *
 * This is the mechanical version of the discipline: a write to an EXISTING
 * file requires that this session read it, and that it has not changed since.
 * Creating a new file is unaffected — there is nothing to have read.
 *
 * The staleness half matters as much as the existence half. A long run edits a
 * file, runs a build that rewrites it, and edits again from a stale picture;
 * or two parallel subagents touch the same file. Recording the mtime turns
 * both into a loud, actionable refusal instead of a silent clobber.
 *
 * ponytail: mtime, not a content hash. A filesystem with 1-second mtime
 * granularity can miss a same-second external write — the tradeoff is one
 * stat() per edit instead of re-reading and hashing every guarded file. Move
 * to a hash if a same-second clobber is ever actually observed.
 */

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Sessions tracked before the oldest is dropped. */
const MAX_SESSIONS = 32;
/** Files remembered per session before the oldest read is dropped. */
const MAX_PATHS_PER_SESSION = 512;

/** sessionId → (canonical path → mtimeMs at the moment it was read). */
const ledger = new Map<string, Map<string, number>>();

/**
 * One spelling per file, so a read and the edit that follows it agree.
 *
 * Two spellings of the same file are common enough to matter: a workspace root
 * under a symlinked temp dir, `C:\Src` vs `c:\src` on Windows, a relative
 * path that resolved elsewhere. Keying the ledger on the raw string would make
 * the gate fire on a file the agent demonstrably just read — a refusal it
 * cannot act on, which is worse than no gate at all.
 *
 * realpathSync throws for a path that does not exist yet (write_file creating
 * a file); resolve() alone is the right answer there.
 */
function canonical(path: string): string {
  let out: string;
  try {
    out = realpathSync(path);
  } catch {
    out = resolve(path);
  }
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/** Current mtime in ms, or null when the file does not exist / is unreadable. */
function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Record that `path` was read in `sessionId`. Called by every tool that shows
 * the agent a file's real contents — `read_file` today; any future viewer must
 * call this too, or its output will not satisfy the gate.
 */
export function noteRead(sessionId: string, path: string): void {
  const key = canonical(path);
  let forSession = ledger.get(sessionId);
  if (!forSession) {
    if (ledger.size >= MAX_SESSIONS) {
      const oldest = ledger.keys().next().value;
      if (oldest !== undefined) ledger.delete(oldest);
    }
    forSession = new Map();
    ledger.set(sessionId, forSession);
  }
  const mtime = mtimeOf(path);
  if (mtime === null) return; // vanished between read and note — nothing to pin
  // Re-insert so this path becomes the most recent for eviction purposes.
  forSession.delete(key);
  forSession.set(key, mtime);
  while (forSession.size > MAX_PATHS_PER_SESSION) {
    const oldest = forSession.keys().next().value;
    if (oldest === undefined) break;
    forSession.delete(oldest);
  }
}

/**
 * Gate a write. Returns null when the write may proceed, or the reason to
 * hand back to the model.
 *
 * The message is written FOR the model: it names the exact tool call that
 * unblocks it, because a refusal an agent cannot act on just burns a turn.
 */
export function checkBeforeWrite(sessionId: string, path: string): string | null {
  const onDisk = mtimeOf(path);
  if (onDisk === null) return null; // new file — nothing to have read

  const seen = ledger.get(sessionId)?.get(canonical(path));
  if (seen === undefined) {
    return (
      `${path} exists but has not been read in this session. ` +
      `Call read_file on it first, then repeat this edit — editing a file you ` +
      `have not seen overwrites work you do not know is there.`
    );
  }
  if (seen !== onDisk) {
    return (
      `${path} changed on disk after you read it (another tool, a build step, ` +
      `or a parallel task). Call read_file again to see the current contents, ` +
      `then redo this edit against them.`
    );
  }
  return null;
}

/**
 * Record the post-write state so the writer may immediately edit again.
 * Without this, a tool's own successful write would invalidate its next edit
 * to the same file — the gate would fire on the agent's own change.
 */
export function noteWrite(sessionId: string, path: string): void {
  noteRead(sessionId, path);
}

/** Drop a session's ledger. Exported for tests and session teardown. */
export function forgetSession(sessionId: string): void {
  ledger.delete(sessionId);
}
