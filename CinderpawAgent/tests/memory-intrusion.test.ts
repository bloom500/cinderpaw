/**
 * The memory block in front of the model has to be mostly about the question.
 *
 * Measured, not asserted by inspection: `scripts/memory-intrusion.ts` seeds a
 * corpus of facts and events across ten unrelated subjects, asks questions that
 * belong to exactly one of them, and counts the injected lines that came from
 * the other nine.
 *
 * The number it produced before this test existed was 85.9% irrelevant at both
 * 300 and 500 memories, because the semantic block was "the 30 newest facts"
 * and the graph block was "the 20 newest edges", neither of which had ever read
 * the question. That is not a tuning miss, it is chance: ten subjects, 10%
 * relevant.
 *
 * The bounds below are deliberately loose. They are here to catch a regression
 * back toward a recency dump, not to freeze today's exact ranking - a better
 * ranker should be free to move these numbers without editing the test, as long
 * as it moves them the right way.
 */

import { describe, expect, test } from "bun:test";
import { measure } from "../scripts/memory-intrusion.ts";

describe("what memory injects is about what was asked", () => {
  test("300 memories: the wrong lines are counted in ones, not in tens", () => {
    const r = measure(300);
    // 47.2 wrong lines per turn before this work, 0.87 after. The absolute
    // count is the bound that matters: a percentage improves on its own
    // whenever the block shrinks, and shrinking the block is not the goal.
    expect(r.wrongLinesPerQuery).toBeLessThan(5);
    // And it still finds the answer: precision bought by injecting nothing
    // would be worse than the problem it fixes.
    expect(r.answerRatePct).toBeGreaterThanOrEqual(85);
  });

  test("500 memories: it does not get worse as the corpus grows", () => {
    // The failure mode this guards: a cap that is fine at 300 and starts
    // throwing the answer away at 500, which is what the old top-30-by-recency
    // did (83.3% answer rate at 500, and its 30 lines were chance).
    const r = measure(500);
    expect(r.wrongLinesPerQuery).toBeLessThan(5);
    expect(r.answerRatePct).toBeGreaterThanOrEqual(85);
  });

  test("the block costs a fraction of what it used to", () => {
    // 55 lines per turn, every turn, forty-seven of them wrong. Tokens are the
    // other half of the bill for an irrelevant memory.
    expect(measure(300).injectedPerQuery).toBeLessThan(30);
  });

  test("the graph block does not repeat the facts block", () => {
    // Every extracted fact is mirrored into the graph, so the two blocks were
    // the same content twice, in two notations, twenty lines apart.
    const r = measure(300);
    expect(r.byLayer.graph!.injected).toBeLessThan(r.byLayer.semantic!.injected);
  });

  test("no relevant memory means an empty block, not a filled one", () => {
    // Two of the thirty questions have no lexical overlap with the fact that
    // answers them ("which herb do I hate" vs "cannot stand coriander"). The
    // right behaviour there is silence: the old code injected five wrong
    // episodic lines instead, which reads to the model as an answer.
    const r = measure(300);
    for (const b of r.blind) expect(b.injected).toBe(0);
  });
});
