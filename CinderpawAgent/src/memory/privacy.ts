import { readEnv } from "../config.ts";
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

// ── Automatic PII redaction (M-2) ────────────────────────────────────────────
//
// `stripPrivate` only removes content the user *explicitly* tagged. This catches
// high-confidence PII patterns automatically, so durable memory (semantic facts)
// never silently retains a card number, IBAN, national ID, email or phone the
// user mentioned in passing. The bar is deliberately HIGH confidence — credit
// cards are Luhn-validated, IBAN/CNP are structurally matched — to keep false
// positives low. Free-form text (names, addresses) is out of scope: it can't be
// matched without an NER model and would be too lossy to redact blindly.

export interface RedactResult {
  text: string;
  /** Total number of PII spans redacted. */
  redactions: number;
  /** Distinct kinds redacted, e.g. ["email", "card"]. */
  kinds: string[];
}

/** Luhn checksum — distinguishes real card numbers from arbitrary digit runs. */
function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Redact high-confidence PII from `input`, returning the cleaned text and what
 * was removed. Each match is replaced with `[REDACTED:<kind>]`. Order matters:
 * structured/anchored patterns run before the looser card scan, and the card
 * scan is Luhn-gated so a national ID or order number isn't mistaken for one.
 */
export function redactPII(input: string): RedactResult {
  let redactions = 0;
  const kinds = new Set<string>();
  const mark = (kind: string): string => {
    redactions++;
    kinds.add(kind);
    return `[REDACTED:${kind}]`;
  };

  let text = input;

  // Email — anchored, very low false-positive rate.
  text = text.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    () => mark("email"),
  );

  // IBAN — 2-letter country, 2 check digits, 11–30 alphanumerics.
  text = text.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, () => mark("iban"));

  // Romanian CNP — S YYMMDD CC NNN C (13 digits with a valid month/day).
  text = text.replace(
    /\b[1-8]\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{6}\b/g,
    () => mark("cnp"),
  );

  // Credit card — 13–19 digits with optional space/dash separators, Luhn-valid.
  text = text.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) =>
    luhnValid(m.replace(/[^\d]/g, "")) ? mark("card") : m,
  );

  // Phone — conservative: international `+` form (the `+` self-anchors; `\b`
  // can't, since `+` is a non-word char), or a RO 07xxxxxxxx mobile.
  text = text.replace(
    /(?:\+\d[\d ().-]{6,}\d|\b07\d{8}\b)/g,
    () => mark("phone"),
  );

  return { text, redactions, kinds: [...kinds] };
}

/** True when PII redaction is enabled (default on; `CINDERPAW_PII_REDACTION=off`). */
export function piiRedactionEnabled(): boolean {
  return readEnv("CINDERPAW_PII_REDACTION") !== "off";
}
