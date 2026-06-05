/**
 * Privacy tag stripping — adapted from claude-mem (thedotmack/claude-mem).
 *
 * Any content wrapped in <private>...</private> is stripped before being
 * written to episodic memory, so sensitive information is never persisted.
 * Multiple tag names are supported for forward-compatibility.
 *
 * Stripping happens at the episodic record boundary (agent-loop.ts), not
 * at the LLM level — the model still sees private content during the turn,
 * but it is never stored to the database.
 *
 * Usage:
 *   user:  "My SSN is <private>123-45-6789</private>, don't store that."
 *   stored: "My SSN is , don't store that."
 */

export type PrivateTagName =
  | "private"
  | "no-memory"
  | "ephemeral";

const TAG_NAMES: PrivateTagName[] = ["private", "no-memory", "ephemeral"];

// Pre-compiled pattern: matches <tag ...>...</tag> including multiline content.
const STRIP_REGEX = new RegExp(
  `<(${TAG_NAMES.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  "gi",
);

export interface StripResult {
  text: string;
  /** Number of private blocks that were removed. */
  stripped: number;
}

/**
 * Remove all private-tagged blocks from `input` and return the cleaned text
 * plus a count of how many blocks were removed.
 */
export function stripPrivate(input: string): StripResult {
  let stripped = 0;
  STRIP_REGEX.lastIndex = 0;
  const text = input
    .replace(STRIP_REGEX, () => {
      stripped++;
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text, stripped };
}

/**
 * Returns true when the input contains at least one private block.
 * Cheap check used to skip the full strip when unnecessary.
 */
export function hasPrivateContent(input: string): boolean {
  STRIP_REGEX.lastIndex = 0;
  return STRIP_REGEX.test(input);
}
