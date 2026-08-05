/**
 * "It says…" — about a file nothing opened.
 *
 * Three tasks in a row today came back with confident, detailed answers built
 * on nothing: a summary of a module that does not exist, complete with its
 * budget ledger and microtask yielding; a directory listing that included that
 * invented file; and "2026.8.1 written to …\VERSION.md" for a folder that was
 * never created. Every one of those turns made ZERO tool calls. The model did
 * not fail to read the file — it never tried.
 *
 * `done_when` covers the case where the task produces an artifact somebody can
 * assert on. It cannot cover an answer, and an answer is what most of these
 * tasks are.
 *
 * So this checks the one thing that needs no judgement: a turn that talks about
 * a file, having opened nothing. Not "does the answer look invented" — that is
 * an opinion, and opinions are what we are trying to stop trusting. Just the
 * mechanical gap between what the answer describes and what the turn actually
 * did.
 *
 * Deliberately narrow, so it never cries wolf:
 *   - only when the turn made NO tool calls at all. A turn that opened
 *     something and then also mentioned a second path is ambiguous, and an
 *     ambiguous warning is a warning people learn to ignore.
 *   - only when a real path shape appears (extension, separator, or drive).
 *     Prose about "the config" is not a claim about a file.
 *   - URLs are not files.
 *
 * It does not accuse. It states what did not happen and lets the reader draw
 * the conclusion — the same discipline as "no done_when declared: unverified".
 */

/** Paths as they appear in prose: `D:\a\b.ts`, `/etc/hosts`, `src/x.ts`, `REPORT.md`. */
const PATH_SHAPES = [
  /\b[A-Za-z]:[\\/][^\s"'`,;)]+/g, // Windows absolute
  /(?<![\w:])\/(?:[\w.-]+\/)+[\w.-]+/g, // POSIX absolute with at least one directory
  /\b[\w.-]+[\\/][\w.-]+(?:[\\/][\w.-]+)*\.\w{1,5}\b/g, // relative with a separator and extension
  /\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|toml|yaml|yml|sh|ps1|txt|sql|html|css)\b/g,
];

/**
 * The first file path an answer claims to know about, or null.
 *
 * Exported for tests and for anything else that needs "is this answer about a
 * file" without re-deriving the shapes.
 */
export function claimedPath(answer: string): string | null {
  const prose = answer
    // Fenced and inline code is quoted material, not a claim about having read.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    // URLs go before path matching, not after: `https://example.com/docs/x.md`
    // contains a perfectly good POSIX path shape, and trying to exclude it by
    // looking at the characters before the match is how you get a rule that
    // works until somebody writes a URL slightly differently.
    .replace(/\bhttps?:\/\/\S+/gi, " ");
  for (const shape of PATH_SHAPES) {
    shape.lastIndex = 0;
    const match = prose.match(shape);
    if (match?.[0]) return match[0];
  }
  return null;
}

/**
 * The line to append to an answer that describes a file the turn never opened,
 * or null when there is nothing to say.
 *
 * `toolCalls` is the whole run's count, not one turn's: a run that read
 * something in its third turn and summarised it in its fifth is doing exactly
 * what it should.
 */
export function unsourcedWarning(answer: string, toolCalls: number): string | null {
  if (toolCalls > 0) return null;
  const path = claimedPath(answer);
  if (!path) return null;
  return (
    `⚠️ _This answer mentions \`${path}\`, but no file was opened and no command ` +
    `was run while producing it — nothing here was checked against your machine._`
  );
}
