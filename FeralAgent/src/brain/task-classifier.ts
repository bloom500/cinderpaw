/**
 * Task classifier — Brain Stack slice 2.
 *
 * Pure function. No I/O, no extra LLM call, no side effects. Maps a single
 * user turn into a `Category` so the Brain Stack router (slice 3) can pick
 * a model. The brief explicitly calls out that a local-LLM classifier is a
 * non-goal — heuristic is enough for MVP; tune the table later.
 *
 * Heuristic order (first match wins — see
 * docs/2026-07-03-brain-stack-minimax-brief.md §3b):
 *   1. `hasImages`                          → "vision"
 *   2. `offline` hint (no cloud reachable)  → "offline"
 *   3. code fences / coding verbs           → "coding"
 *   4. reasoning cues OR long prompt        → "reasoning"
 *   5. creative cues                        → "creative"
 *   6. otherwise                            → "simple"
 *
 * The keyword sets are exported as `RegExp[]` so they're inspectable from
 * tests and tunable from config later (slice S3 will read `brain.json`,
 * which is where user overrides will land).
 *
 * Why word boundaries: a naïve substring match on the brief's keyword
 * list produces obvious false positives — "showy" matches "why", "improve"
 * matches "prove", "dysfunction" matches "function". `\b` rejects those.
 * Multi-word phrases ("step by step", "stack trace", "write a story") use
 * boundary on the far end only so they can land mid-sentence.
 *
 * Why a separate confidence band per rule type: vision and offline are
 * caller-known facts (binary truth), so they're high-confidence. Keyword
 * matches are heuristics that can false-positive, so they're medium.
 * "Simple" is the bucket for "no signal at all" and is therefore low.
 * Downstream scoring uses confidence only as a tiebreaker, so the
 * absolute values don't matter — only the ordering.
 */

import type { Category } from "./capability-registry.ts";

/** Output of `classify()`. */
export interface Classification {
  category: Category;
  /** 0..1. Higher = classifier more confident. Used as a tiebreaker in scoring. */
  confidence: number;
}

/** Input shape for `classify()`. */
export interface ClassifierInput {
  /** The user's text — may be empty, may contain code, may be very long. */
  text: string;
  /** True when the user attached images. Wins over every other rule. */
  hasImages: boolean;
  /**
   * Hint from the caller (agent-loop / router): no cloud target is reachable.
   * Beats every keyword-based rule except `hasImages`.
   */
  offline: boolean;
}

/**
 * Character threshold above which a prompt is treated as "long" → reasoning.
 * Tunable. The brief doesn't pick a number; 1500 chars is the "feels long
 * without being pathological" choice — a normal chat message is well under
 * 500 chars, a request that genuinely needs reasoning usually pushes past
 * a paragraph.
 */
export const LONG_PROMPT_CHARS = 1500;

/**
 * Confidence bands. Order matters: `binary > keyword > fallback`.
 * Downstream scoring treats these as tiebreakers, so the exact values
 * are not load-bearing — only the relative ordering.
 */
export const CONFIDENCE = {
  /** Caller-known facts (hasImages, offline). */
  binary: 0.95,
  /** Keyword heuristic match — could be a false positive. */
  keyword: 0.75,
  /** No signal at all → "simple". */
  fallback: 0.5,
} as const;

/**
 * Code fences / coding verbs. Single tokens use word boundaries on both
 * sides; multi-word phrases use a single boundary on the right so they
 * can land mid-sentence ("explain this stack trace from yesterday").
 */
export const CODE_PATTERNS: readonly RegExp[] = [
  /\brefactor\b/i,
  /\bdebug\b/i,
  /\bcompile\b/i,
  /stack trace\b/i,
  /\bregex\b/i,
  /\bfunction\b/i,
  /```/, // markdown code fence
];

/**
 * Reasoning cues. Same boundary rules as code. "why" needs a boundary so
 * "showy" doesn't trigger reasoning.
 */
export const REASONING_PATTERNS: readonly RegExp[] = [
  /\bprove\b/i, // won't match "improve" (boundary on left)
  /\bderive\b/i,
  /step by step/i,
  /\banalyze\b/i,
  /\banalyse\b/i,
  /\bwhy\b/i, // won't match "showy"
];

/**
 * Creative cues. Slightly looser on plurals (`poems?`, `lyrics?`) because
 * users naturally say "write poems" not "write poem". `imagine` keeps a
 * strict boundary — "imagination" isn't the same intent.
 */
export const CREATIVE_PATTERNS: readonly RegExp[] = [
  /write a story/i,
  /\bpoems?\b/i,
  /\blyrics?\b/i,
  /\bimagine\b/i,
];

function hasAnyMatch(text: string, patterns: readonly RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}

/**
 * Classify one user turn. Pure; no I/O; no LLM call. First matching rule
 * wins; ties resolve in document order (vision beats offline beats coding
 * beats reasoning beats creative beats simple).
 *
 * The order is documented in the file header and again here because
 * reordering silently changes routing for every prompt that hits two
 * rules. If you change the order, audit the precedence tests in
 * `tests/task-classifier.test.ts`.
 */
export function classify(input: ClassifierInput): Classification {
  // 1. images → vision (beats everything)
  if (input.hasImages) {
    return { category: "vision", confidence: CONFIDENCE.binary };
  }

  // 2. offline hint → offline (beats keyword rules)
  if (input.offline) {
    return { category: "offline", confidence: CONFIDENCE.binary };
  }

  const text = input.text;

  // 3. code fences / verbs → coding
  if (hasAnyMatch(text, CODE_PATTERNS)) {
    return { category: "coding", confidence: CONFIDENCE.keyword };
  }

  // 4. reasoning cues OR long prompt → reasoning
  if (
    hasAnyMatch(text, REASONING_PATTERNS) ||
    text.length > LONG_PROMPT_CHARS
  ) {
    return { category: "reasoning", confidence: CONFIDENCE.keyword };
  }

  // 5. creative cues → creative
  if (hasAnyMatch(text, CREATIVE_PATTERNS)) {
    return { category: "creative", confidence: CONFIDENCE.keyword };
  }

  // 6. default → simple
  return { category: "simple", confidence: CONFIDENCE.fallback };
}