/**
 * What a run id is allowed to be — one definition, because two would drift.
 *
 * A run id names one benchmark episode / harness run, and it ends up in
 * filesystem paths (skill sinks, TTT datasets, result logs). That gives it
 * two jobs at once: it isolates episodes from each other, and it is
 * untrusted input the moment it arrives from a CLI flag or a config file.
 *
 * Refusal, not sanitization. Rewriting "ep/../../etc" into something legal
 * would silently map two different runs onto one directory, which is
 * precisely the leak the scoping exists to prevent — a quiet collision is
 * worse than a loud rejection.
 */

/**
 * Characters a run id may contain. Deliberately narrow and portable.
 *
 * LOWERCASE ONLY, and that is the portability half rather than a style rule.
 * Windows (NTFS) and macOS (APFS) resolve directory names case-insensitively,
 * so `run-1` and `RUN-1` are two ids and one directory: the second run's
 * journal, skills and connector store land on top of the first's, and run N's
 * learned skills are on run N+1's disk to be read. Measured — `mkdir run1`
 * followed by `mkdir RUN1` leaves one directory on this machine.
 *
 * That is the exact leak the per-run scoping exists to prevent (INVARIANT I13),
 * arriving with no traversal and no rewriting. Case-FOLDING would be the wrong
 * fix for the reason stated above: it maps two different runs onto one
 * directory, which is the leak rather than the cure.
 */
const RUN_ID_PATTERN = /^[a-z0-9._-]+$/;

export function assertValidRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error(`runId must be a non-empty string, got ${String(runId)}`);
  }
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    // Two messages, because the two refusals have different fixes and a
    // reader who is told "not path-safe" for `RUN-1` goes looking for a slash
    // that is not there.
    if (/[A-Z]/.test(runId)) {
      throw new Error(
        `runId "${runId}" must be lowercase — use "${runId.toLowerCase()}". ` +
          "Windows and macOS treat it as the same directory as its lowercase " +
          "spelling, so two runs whose ids differ only in case would share one " +
          "profile dir and read each other's data.",
      );
    }
    throw new Error(
      `runId "${runId}" is not path-safe - use only lowercase letters, digits, ` +
        "dot, underscore or hyphen",
    );
  }
}

/** Non-throwing form, for callers offering a choice rather than failing. */
export function isValidRunId(runId: unknown): runId is string {
  try {
    assertValidRunId(runId);
    return true;
  } catch {
    return false;
  }
}
