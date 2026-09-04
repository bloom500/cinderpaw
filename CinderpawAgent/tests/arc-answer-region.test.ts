/**
 * A press must come from a DECISION, not from text that happened to contain a
 * button name.
 *
 * This suite exists because of one real press. It cost 65,536 completion tokens
 * — exactly the output ceiling — and the reply ended mid-sentence inside its own
 * reasoning with no answer after it. The old parser scanned the whole transcript
 * for the last mention of an offered action, found "ACTION3/4/6/7 correspond to
 * operations like fill, erase" in the model's notes, and pressed ACTION3. The
 * trace recorded `source: "model"`. The model had decided nothing.
 *
 * A benchmark that spends too much can be optimised. A benchmark carrying
 * actions the model never chose is not a benchmark, so every case below is a
 * release gate rather than a nicety.
 */
import { describe, expect, test } from "bun:test";
import { answerRegion, parseChoice, renderGrid, renderScene, renderClickCandidates } from "../src/arc/model-policy.ts";
import { colourChar } from "../src/arc/colour.ts";

const OFFERED = ["ACTION1", "ACTION3", "ACTION4", "ACTION6", "ACTION7"];

describe("answerRegion", () => {
  test("a reply with no thinking block is all answer", () => {
    expect(answerRegion("ACTION3")).toBe("ACTION3");
  });

  test("only what follows the last </think> counts", () => {
    expect(answerRegion("<think>maybe ACTION1</think>ACTION4")).toBe("ACTION4");
  });

  test("nested or repeated thinking blocks resolve to the final answer", () => {
    expect(answerRegion("<think>a</think>noise<think>b</think>ACTION7")).toBe("ACTION7");
  });

  test("THE 65,536-TOKEN CASE: truncated thinking has no answer at all", () => {
    // Truncation is the whole point: the tag never closes because the model ran
    // out of room, so everything present is reasoning.
    expect(answerRegion("<think>I should consider ACTION3 and ACTION4 and")).toBeNull();
  });

  test("thinking that closes but says nothing after it is not an answer", () => {
    expect(answerRegion("<think>ACTION3 looks good</think>")).toBeNull();
    expect(answerRegion("<think>ACTION3 looks good</think>   \n  ")).toBeNull();
  });

  test("an empty reply is not an answer", () => {
    expect(answerRegion("")).toBeNull();
    expect(answerRegion("   ")).toBeNull();
  });

  test("a non-string reply is not an answer", () => {
    expect(answerRegion(undefined as unknown as string)).toBeNull();
  });
});

describe("parseChoice only reads the answer", () => {
  test("buttons named while thinking are NOT a decision", () => {
    const reply = "<think>ACTION3/4/6/7 correspond to fill, erase, click, undo</think>";
    expect(parseChoice(reply, OFFERED)).toBeNull();
  });

  test("the exact shape of the 65,536-token press yields no action", () => {
    const reply =
      "<think>Could be a tool-use puzzle where ACTION3/ACTION4/ACTION6/ACTION7 " +
      "correspond to operations. Wait colors list says 10x1805, 3x178, 14x147,";
    expect(parseChoice(reply, OFFERED)).toBeNull();
  });

  test("a real decision after the thinking is honoured", () => {
    expect(parseChoice("<think>ACTION1 then ACTION3 maybe</think>ACTION4", OFFERED)).toBe("ACTION4");
  });

  test("coordinates survive into the answer", () => {
    expect(parseChoice("<think>where?</think>ACTION6:21,38", OFFERED)).toBe("ACTION6:21,38");
  });

  test("the LAST button in the answer wins, thinking notwithstanding", () => {
    expect(parseChoice("<think>ACTION7</think>I will press ACTION1, no — ACTION3", OFFERED)).toBe("ACTION3");
  });

  test("a button that was not offered cannot be chosen", () => {
    expect(parseChoice("ACTION2", OFFERED)).toBeNull();
    expect(parseChoice("<think>x</think>ACTION5", OFFERED)).toBeNull();
  });

  test("case is forgiven in the answer, since the fallback costs a whole press", () => {
    expect(parseChoice("action3", OFFERED)).toBe("ACTION3");
  });

  test("a repeated action is still one decision", () => {
    expect(parseChoice("ACTION3 ACTION3 ACTION3", OFFERED)).toBe("ACTION3");
  });

  /**
   * KNOWN LIMIT, pinned deliberately rather than papered over.
   *
   * A model whose ANSWER is nothing but an echo of the button list still parses
   * — we take the last name and press it. The guard cannot tell that apart from
   * "I considered A and B, I press B" without a heuristic that would also reject
   * real answers, and rejecting a real answer costs a whole press.
   *
   * It is accepted because it has never been observed: the failure that cost us
   * a run was truncation, where there is no answer region at all, and that is
   * closed. If a run ever shows echo-shaped presses, `why.reply` in the trace is
   * what makes them visible — this test is the note explaining what to look for.
   */
  test("KNOWN LIMIT: a pure echo in the ANSWER region still parses", () => {
    expect(parseChoice("Buttons available now: ACTION1, ACTION3", OFFERED)).toBe("ACTION3");
  });

  test("but an echo inside the THINKING is not a decision", () => {
    // The system prompt names the format; a model repeating it back has not chosen.
    expect(
      parseChoice("<think>The buttons available now: ACTION1, ACTION3, ACTION4.</think>", OFFERED),
    ).toBeNull();
  });
});

describe("one colour encoding, everywhere the model can see", () => {
  test("colourChar is hex for 0..15 and honest about anything else", () => {
    expect([...Array(16).keys()].map(colourChar).join("")).toBe("0123456789abcdef");
    expect(colourChar(16)).toBe("?");
    expect(colourChar(-1)).toBe("?");
    expect(colourChar(1.5)).toBe("?");
  });

  test("THE 65,536-TOKEN CONFUSION: grid, scene and candidates agree on all 16", () => {
    // A 6x6 board per colour: a background, plus a 2x2 block of the colour under
    // test. Whatever character the grid uses for it, the scene summary and the
    // candidate list must use the SAME one — this is the invariant whose absence
    // made a model derive the hex/decimal mapping by hand, expensively.
    for (let colour = 0; colour <= 15; colour++) {
      const background = colour === 0 ? 1 : 0;
      const g = Array.from({ length: 6 }, () => Array(6).fill(background));
      for (const r of [1, 2]) for (const c of [1, 2]) g[r][c] = colour;

      const ch = colourChar(colour);
      expect(renderGrid(g)).toContain(ch);

      const scene = renderScene(g);
      expect(scene).not.toBeNull();
      expect(scene).toContain(`color: ${ch}`);
      // And the decimal form must NOT appear for the colours where the two
      // encodings differ, which is exactly 10..15.
      if (colour >= 10) expect(scene).not.toContain(`color: ${colour}`);

      const candidates = renderClickCandidates(g);
      expect(candidates).not.toBeNull();
      expect(candidates).toContain(`colour ${ch}`);
      if (colour >= 10) expect(candidates).not.toContain(`colour ${colour},`);
    }
  });
});
