/**
 * Task classifier — Brain Stack slice 2.
 *
 * Asserts on real behaviour, not stubs. Covers:
 *   - one test per category (so a regression in any single rule is loud)
 *   - precedence interactions (vision > offline > coding > reasoning >
 *     creative > simple — reordering these silently changes routing for
 *     every prompt that hits two rules; tests guard the order)
 *   - word-boundary correctness (the keyword regexes MUST reject
 *     "improve"/"showy"/"dysfunction" — a naïve substring match would
 *     be a silent routing bug)
 *   - long-prompt fallback to reasoning (threshold = LONG_PROMPT_CHARS)
 *   - confidence bands stay ordered: binary > keyword > fallback
 *   - edge cases: empty string, whitespace, punctuation, non-ASCII
 *
 * Heuristic table is exported (CODE_PATTERNS / REASONING_PATTERNS /
 * CREATIVE_PATTERNS / LONG_PROMPT_CHARS) so the tests can verify the
 * table shape without scraping it out of the implementation.
 */

import { describe, expect, test } from "bun:test";

import {
  classify,
  CODE_PATTERNS,
  CONFIDENCE,
  CREATIVE_PATTERNS,
  LONG_PROMPT_CHARS,
  REASONING_PATTERNS,
  type ClassifierInput,
} from "../src/brain/task-classifier.ts";

// ---------------------------------------------------------------------------
// Tiny helper — build a ClassifierInput with sensible defaults.
// ---------------------------------------------------------------------------

function classify1(partial: Partial<ClassifierInput>): ReturnType<typeof classify> {
  return classify({
    text: "",
    hasImages: false,
    offline: false,
    ...partial,
  });
}

// ---------------------------------------------------------------------------
// One test per category — make regressions loud.
// ---------------------------------------------------------------------------

describe("classify() — one test per category", () => {
  test("vision: hasImages=true routes to vision regardless of text", () => {
    const out = classify1({
      text: "explain this image please, also refactor my code",
      hasImages: true,
    });
    expect(out.category).toBe("vision");
  });

  test("offline: offline=true with no images routes to offline", () => {
    const out = classify1({ offline: true, text: "what's the weather" });
    expect(out.category).toBe("offline");
  });

  test("coding: code fence routes to coding", () => {
    const out = classify1({ text: "fix this:\n```js\nfoo()\n```" });
    expect(out.category).toBe("coding");
  });

  test("coding: 'refactor' verb routes to coding", () => {
    const out = classify1({ text: "please refactor this function" });
    expect(out.category).toBe("coding");
  });

  test("reasoning: 'prove' cue routes to reasoning", () => {
    const out = classify1({ text: "prove the Pythagorean theorem" });
    expect(out.category).toBe("reasoning");
  });

  test("reasoning: 'step by step' phrase routes to reasoning", () => {
    const out = classify1({
      text: "explain step by step how TLS works",
    });
    expect(out.category).toBe("reasoning");
  });

  test("reasoning: long prompt (length > LONG_PROMPT_CHARS) routes to reasoning", () => {
    const out = classify1({ text: "a".repeat(LONG_PROMPT_CHARS + 1) });
    expect(out.category).toBe("reasoning");
  });

  test("creative: 'write a story' phrase routes to creative", () => {
    const out = classify1({ text: "write a story about a lighthouse" });
    expect(out.category).toBe("creative");
  });

  test("creative: 'poem' (and 'poems') routes to creative", () => {
    expect(classify1({ text: "write me a poem" }).category).toBe("creative");
    expect(classify1({ text: "write me some poems" }).category).toBe("creative");
  });

  test("simple: short factual 'what time is it' routes to simple", () => {
    expect(classify1({ text: "what time is it" }).category).toBe("simple");
  });

  test("simple: empty string routes to simple", () => {
    expect(classify1({ text: "" }).category).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// Precedence — guard the rule order. Reordering silently changes routing
// for every prompt that matches multiple rules.
// ---------------------------------------------------------------------------

describe("classify() — precedence", () => {
  test("vision beats offline", () => {
    const out = classify1({ hasImages: true, offline: true });
    expect(out.category).toBe("vision");
  });

  test("vision beats coding keyword in the same prompt", () => {
    const out = classify1({
      hasImages: true,
      text: "refactor this function in the screenshot",
    });
    expect(out.category).toBe("vision");
  });

  test("offline beats coding keyword in the same prompt", () => {
    const out = classify1({ offline: true, text: "refactor this" });
    expect(out.category).toBe("offline");
  });

  test("offline beats long-prompt reasoning", () => {
    const out = classify1({
      offline: true,
      text: "a".repeat(LONG_PROMPT_CHARS + 100),
    });
    expect(out.category).toBe("offline");
  });

  test("coding beats reasoning keyword in the same prompt", () => {
    const out = classify1({
      text: "refactor and analyze this code",
    });
    expect(out.category).toBe("coding");
  });

  test("coding beats long-prompt heuristic", () => {
    // Long prompt + code verb → coding wins (rule 3 before rule 4).
    const out = classify1({
      text: `${"refactor ".repeat(500)} this thing`,
    });
    expect(out.category).toBe("coding");
  });

  test("reasoning beats creative when both keywords appear", () => {
    // 'analyze' triggers reasoning before 'poem' can trigger creative.
    const out = classify1({
      text: "analyze this poem line by line",
    });
    expect(out.category).toBe("reasoning");
  });

  test("creative beats simple for a creative-only prompt", () => {
    const out = classify1({ text: "imagine a world without clocks" });
    expect(out.category).toBe("creative");
  });
});

// ---------------------------------------------------------------------------
// Word boundaries — the regex MUST reject obvious false positives.
// A naïve substring match would be a silent routing bug.
// ---------------------------------------------------------------------------

describe("classify() — word boundary correctness", () => {
  test("'improve' must NOT trigger 'prove' (left-boundary guards)", () => {
    const out = classify1({ text: "how do I improve my workflow" });
    expect(out.category).toBe("simple");
  });

  test("'showy' must NOT trigger 'why' (left-boundary guards)", () => {
    const out = classify1({ text: "that pattern is showy and loud" });
    expect(out.category).toBe("simple");
  });

  test("'dysfunction' must NOT trigger 'function' (left-boundary guards)", () => {
    const out = classify1({ text: "team dysfunction is the root cause" });
    expect(out.category).toBe("simple");
  });

  test("'compiler' must NOT trigger 'compile' (right-boundary guards)", () => {
    const out = classify1({ text: "the compiler crashed" });
    expect(out.category).toBe("simple");
  });

  test("'debugger' must NOT trigger 'debug' (right-boundary guards)", () => {
    const out = classify1({ text: "attach the debugger now" });
    expect(out.category).toBe("simple");
  });

  test("'regexes' must NOT trigger 'regex' (right-boundary guards)", () => {
    // Strict regex pattern — only the exact word 'regex' counts.
    const out = classify1({ text: "modern regexes are powerful" });
    expect(out.category).toBe("simple");
  });

  test("'poet' must NOT trigger 'poem' (right-boundary guards)", () => {
    const out = classify1({ text: "she is a poet" });
    expect(out.category).toBe("simple");
  });

  test("'imagined' must NOT trigger 'imagine' (right-boundary guards)", () => {
    const out = classify1({ text: "I imagined a quiet room" });
    expect(out.category).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// Case-insensitivity — keywords work regardless of casing.
// ---------------------------------------------------------------------------

describe("classify() — case insensitivity", () => {
  test("UPPERCASE 'REFACTOR' routes to coding", () => {
    expect(classify1({ text: "PLEASE REFACTOR THIS" }).category).toBe("coding");
  });

  test("Mixed case 'PrOvE' routes to reasoning", () => {
    expect(classify1({ text: "PrOvE this assertion" }).category).toBe("reasoning");
  });

  test("UPPERCASE 'WHY' routes to reasoning", () => {
    expect(classify1({ text: "WHY does this happen" }).category).toBe("reasoning");
  });
});

// ---------------------------------------------------------------------------
// Long-prompt threshold — boundary at exactly LONG_PROMPT_CHARS.
// ---------------------------------------------------------------------------

describe("classify() — long-prompt threshold", () => {
  test("text of exactly LONG_PROMPT_CHARS chars does NOT trigger reasoning", () => {
    const text = "a".repeat(LONG_PROMPT_CHARS);
    const out = classify1({ text });
    expect(out.category).toBe("simple"); // length === threshold, not >
  });

  test("text of LONG_PROMPT_CHARS + 1 chars DOES trigger reasoning", () => {
    const text = "a".repeat(LONG_PROMPT_CHARS + 1);
    const out = classify1({ text });
    expect(out.category).toBe("reasoning");
  });
});

// ---------------------------------------------------------------------------
// Edge cases — inputs that should NOT crash, and should classify sanely.
// ---------------------------------------------------------------------------

describe("classify() — edge cases", () => {
  test("pure punctuation routes to simple", () => {
    expect(classify1({ text: "..." }).category).toBe("simple");
    expect(classify1({ text: "?!?!" }).category).toBe("simple");
  });

  test("whitespace-only text routes to simple", () => {
    expect(classify1({ text: "   " }).category).toBe("simple");
    expect(classify1({ text: "\n\t  " }).category).toBe("simple");
  });

  test("non-ASCII (emoji + accented) text routes to simple", () => {
    expect(classify1({ text: "café ☕ 🌅" }).category).toBe("simple");
  });

  test("very short non-empty text with no keywords routes to simple", () => {
    expect(classify1({ text: "hi" }).category).toBe("simple");
    expect(classify1({ text: "ok" }).category).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// Confidence bands — the heuristic produces ordered confidence values.
// binary > keyword > fallback. Downstream scoring treats these as
// tiebreakers, so the relative ordering is what matters.
// ---------------------------------------------------------------------------

describe("classify() — confidence bands", () => {
  test("vision (binary) returns binary confidence", () => {
    const out = classify1({ hasImages: true });
    expect(out.confidence).toBe(CONFIDENCE.binary);
  });

  test("offline (binary) returns binary confidence", () => {
    const out = classify1({ offline: true });
    expect(out.confidence).toBe(CONFIDENCE.binary);
  });

  test("coding keyword match returns keyword confidence", () => {
    const out = classify1({ text: "refactor this" });
    expect(out.confidence).toBe(CONFIDENCE.keyword);
  });

  test("reasoning keyword match returns keyword confidence", () => {
    const out = classify1({ text: "prove this" });
    expect(out.confidence).toBe(CONFIDENCE.keyword);
  });

  test("creative keyword match returns keyword confidence", () => {
    const out = classify1({ text: "write a story" });
    expect(out.confidence).toBe(CONFIDENCE.keyword);
  });

  test("fallback returns fallback confidence", () => {
    const out = classify1({ text: "hi" });
    expect(out.confidence).toBe(CONFIDENCE.fallback);
  });

  test("confidence bands are strictly ordered: binary > keyword > fallback", () => {
    expect(CONFIDENCE.binary).toBeGreaterThan(CONFIDENCE.keyword);
    expect(CONFIDENCE.keyword).toBeGreaterThan(CONFIDENCE.fallback);
  });

  test("all confidences are in [0, 1]", () => {
    expect(CONFIDENCE.binary).toBeGreaterThanOrEqual(0);
    expect(CONFIDENCE.binary).toBeLessThanOrEqual(1);
    expect(CONFIDENCE.keyword).toBeGreaterThanOrEqual(0);
    expect(CONFIDENCE.keyword).toBeLessThanOrEqual(1);
    expect(CONFIDENCE.fallback).toBeGreaterThanOrEqual(0);
    expect(CONFIDENCE.fallback).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Heuristic table shape — exported patterns are non-empty arrays of RegExp.
// Catches accidental deletion of a pattern from the table.
// ---------------------------------------------------------------------------

describe("heuristic table shape", () => {
  test("CODE_PATTERNS has at least one entry and every entry is a RegExp", () => {
    expect(CODE_PATTERNS.length).toBeGreaterThan(0);
    for (const p of CODE_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });

  test("REASONING_PATTERNS has at least one entry and every entry is a RegExp", () => {
    expect(REASONING_PATTERNS.length).toBeGreaterThan(0);
    for (const p of REASONING_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });

  test("CREATIVE_PATTERNS has at least one entry and every entry is a RegExp", () => {
    expect(CREATIVE_PATTERNS.length).toBeGreaterThan(0);
    for (const p of CREATIVE_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });

  test("LONG_PROMPT_CHARS is a positive integer", () => {
    expect(Number.isInteger(LONG_PROMPT_CHARS)).toBe(true);
    expect(LONG_PROMPT_CHARS).toBeGreaterThan(0);
  });
});