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

/** Characters a run id may contain. Deliberately narrow and portable. */
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function assertValidRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error(`runId must be a non-empty string, got ${String(runId)}`);
  }
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new Error(
      `runId "${runId}" is not path-safe - use only letters, digits, dot, ` +
        "underscore or hyphen",
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
