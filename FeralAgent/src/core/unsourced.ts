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
    // Fenced blocks are quoted material — code the agent is proposing, not a
    // claim about having read something.
    .replace(/```[\s\S]*?```/g, " ")
    // Inline code is NOT stripped, and that is the whole difference between a
    // detector that works and one that never fires. Models write paths in
    // backticks by habit — `src/core/loop.ts` — so removing inline code removes
    // exactly the claims this is here to catch. Found live: the warning stayed
    // silent through a full round of fabricated answers for this one reason.
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
 * The user's message, with the one instruction the model actually obeys added
 * when the message names a file.
 *
 * The warning below is a footnote on damage already done. This is the same
 * detector pointed the other way — before the turn instead of after it.
 *
 * It exists because of a measurement, not a theory: this model reaches for a
 * tool when it is told to in those words ("read it with a tool, do not answer
 * from memory") and invents fluently when it is not. Same prompt, same model,
 * one sentence apart. An A/B against a build from before any of today's changes
 * produced the identical fabricated answer word for word, so the gap is not
 * something more prompt engineering in SOUL.md closes — a general rule there was
 * tried, verified present in the running binary, and ignored completely. A rule
 * attached to the specific message, naming the specific file, is not.
 *
 * So the person no longer has to know the magic words. If their message names a
 * file, we say them.
 *
 * The trigger is `claimedPath`, deliberately: the layer that prevents and the
 * layer that warns then agree by construction on what counts as a claim about a
 * file. Cost when it does not fire: one regex over the message.
 */
export function withOpenFirst(userText: string): string {
  const path = claimedPath(userText);
  if (!path) return userText;
  return (
    `${userText}\n\n` +
    `[Open \`${path}\` with a tool and read it before you describe it. ` +
    `Do not answer from memory.]`
  );
}

/**
 * The line to append to an answer that describes a file the turn never opened,
 * or null when there is nothing to say.
 *
 * `toolCalls` is the whole run's count, not one turn's: a run that read
 * something in its third turn and summarised it in its fifth is doing exactly
 * what it should.
 */
export function unsourcedWarning(
  answer: string,
  toolCalls: number,
  /**
   * What was asked. Checked as well as the answer, because the strongest case
   * is the one the answer hides: asked to summarise a named file, the model
   * described it at length WITHOUT ever naming it again — so an answer-only
   * check found nothing to object to while the whole reply was invented. What
   * the person named is the claim; whether the agent repeats it is style.
   */
  prompt = "",
): string | null {
  if (toolCalls > 0) return null;
  const path = claimedPath(answer) ?? claimedPath(prompt);
  if (!path) return null;
  return (
    `⚠️ _This is about \`${path}\`, but no file was opened and no command was run ` +
    `while producing this answer — nothing here was checked against your machine._`
  );
}
