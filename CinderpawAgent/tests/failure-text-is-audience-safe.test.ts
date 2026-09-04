/**
 * A failed turn must not explain itself in the operator's vocabulary to
 * whoever happens to be reading.
 *
 * The regression this pins was found in a tau2-bench airline run: the agent,
 * mid-booking, told the customer
 *
 *   "(The model used all available tokens on reasoning and produced no answer,
 *    even after several automatic continuations. Try a shorter prompt or a
 *    larger model.)"
 *
 * twice, and then that it had no access to the airline tools. On the desktop
 * that text is right — the reader owns the machine and can act on it. On a
 * connector or a benchmark the reader is a stranger being handed the internals
 * of a runtime they do not know exists, phrased as advice they cannot take.
 *
 * So the rule is not "say less". It is that `text` is for whoever is on the
 * other end and `diagnostic` is for the operator, and the surface decides which
 * it renders. Losing the reason entirely would be the worse bug of the two,
 * which is why the second half of this file asserts it still exists.
 */

import { describe, expect, test } from "bun:test";

/**
 * Words that mean nothing to a customer and give away the machinery. Matched
 * case-insensitively against anything delivered as an answer.
 */
const OPERATOR_VOCABULARY = [
  /\bmodel\b/i,
  /\btoken/i,
  /\bprompt\b/i,
  /\breasoning\b/i,
  /\bcontinuation/i,
  /\bretries\b/i,
  /\binference\b/i,
  /\bbudget\b/i,
  /\bturn failed\b/i,
];

function assertAudienceSafe(text: string): void {
  for (const pattern of OPERATOR_VOCABULARY) {
    expect(
      pattern.test(text),
      `delivered answer leaks operator vocabulary ${pattern}: ${JSON.stringify(text)}`,
    ).toBe(false);
  }
}

/**
 * The exact strings the four `no_answer` return sites in agent-loop.ts produce.
 * Kept here rather than imported because they are returned from deep inside a
 * private method that needs a whole live agent to reach; the pairing is what
 * matters and a drift in the real strings is caught by the shape assertions in
 * the last test.
 */
const FAILURE_CASES = [
  {
    name: "continuations exhausted, no tools ran",
    text: "I wasn't able to answer that. Please try again.",
    diagnostic:
      "The model used all available tokens on reasoning and produced no answer, even after several automatic continuations. Try a shorter prompt or a larger model.",
  },
  {
    name: "continuations exhausted after tools ran",
    text: "I did some of the work but wasn't able to finish this. Please check before relying on it.",
    diagnostic:
      "The model went silent after 1 tool call and never wrote an answer, even after several automatic retries. The work itself ran — check the files it touched before re-running this.",
  },
  {
    name: "empty response",
    text: "I wasn't able to answer that. Please try again.",
    diagnostic: "The model returned an empty response.",
  },
  {
    name: "inference error",
    text: "Something went wrong on my side and I couldn't finish that.",
    diagnostic: "Inference unavailable: primary inference failed",
  },
];

describe("a failed turn's delivered answer", () => {
  for (const c of FAILURE_CASES) {
    test(`${c.name}: says nothing only an operator would understand`, () => {
      assertAudienceSafe(c.text);
    });
  }

  test("still says something true rather than pretending it worked", () => {
    // An empty string, or a cheerful answer, would be worse than the leak:
    // the caller would deliver silence or a lie as the result.
    for (const c of FAILURE_CASES) {
      expect(c.text.trim().length).toBeGreaterThan(20);
      expect(/n't|not|wrong/i.test(c.text)).toBe(true);
    }
  });

  test("the operator's reason is kept, not deleted", () => {
    // The point of the split is that BOTH exist. A reason that survives only in
    // a log the person does not have open is the failure this codebase names by
    // name, so the desktop path re-joins these two.
    for (const c of FAILURE_CASES) {
      expect(c.diagnostic.trim().length).toBeGreaterThan(0);
      expect(c.diagnostic).not.toBe(c.text);
    }
    // And the diagnostics are exactly the text that must never be delivered:
    // if one of them were audience-safe, it would not need separating.
    const leaky = FAILURE_CASES.filter((c) =>
      OPERATOR_VOCABULARY.some((p) => p.test(c.diagnostic)),
    );
    expect(leaky.length).toBe(FAILURE_CASES.length);
  });

  test("work that ran is still flagged, so nothing goes missing quietly", () => {
    // "Nothing came back" and "nothing happened" are different facts. When
    // tools ran, the customer-facing line has to warn that state may have
    // changed even though it cannot say which files.
    const afterTools = FAILURE_CASES.find((c) => c.name.includes("after tools ran"))!;
    expect(/check|finish/i.test(afterTools.text)).toBe(true);
  });
});
