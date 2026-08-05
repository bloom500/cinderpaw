/**
 * The three answers that motivated this, verbatim in shape, plus the cases
 * where staying quiet matters more than warning.
 *
 * A warning that fires on ordinary conversation is a warning people switch
 * off, and then it protects nobody. So the bar is: a real path shape, and a
 * turn that opened nothing at all.
 */
import { describe, expect, test } from "bun:test";
import { claimedPath, unsourcedWarning } from "../src/core/unsourced.ts";

describe("an answer about a file nothing opened", () => {
  test("the fabricated module summary is flagged", () => {
    const answer =
      "QuantumScheduler, in plain terms: it decides when and on which thread a " +
      "microtask runs. See D:\\FeralLocalAI\\FeralAgent\\src\\core\\quantum-scheduler.ts.";
    expect(unsourcedWarning(answer, 0)).toContain("quantum-scheduler.ts");
    expect(unsourcedWarning(answer, 0)).toContain("no file was opened");
  });

  test("the fabricated write is flagged", () => {
    expect(unsourcedWarning("2026.8.1 written to walkaway-demo6/VERSION.md.", 0)).toBeTruthy();
  });

  test("a fabricated directory listing is flagged", () => {
    const answer = "The actual core/ contents I can see are quantum-scheduler.ts, dispatcher.ts.";
    expect(unsourcedWarning(answer, 0)).toBeTruthy();
  });

  test("a turn that actually used tools is never flagged", () => {
    // The whole point: evidence exists, so the reader needs no footnote.
    const answer = "I read D:\\FeralLocalAI\\FeralAgent\\package.json — the version is 2026.8.1.";
    expect(unsourcedWarning(answer, 1)).toBeNull();
    expect(unsourcedWarning(answer, 12)).toBeNull();
  });

  test("ordinary conversation is left alone", () => {
    expect(unsourcedWarning("Hey — what would you like me to look at?", 0)).toBeNull();
    expect(unsourcedWarning("Sure, I can help with the deployment config.", 0)).toBeNull();
    expect(unsourcedWarning("Version 2026.8.1 is the current release.", 0)).toBeNull();
  });

  test("a URL is not a file on this machine", () => {
    expect(unsourcedWarning("See https://example.com/docs/setup.md for details.", 0)).toBeNull();
  });

  test("a path in backticks is still a claim — models write them that way", () => {
    // The reason the detector stayed silent through a whole round of fabricated
    // answers: paths arrive as `src/core/x.ts` far more often than bare.
    expect(
      unsourcedWarning("2026.8.1 written to `D:\proj\walkaway-demo6\VERSION.md`.", 0),
    ).toBeTruthy();
    expect(unsourcedWarning("I checked `src/core/loop.ts` and it looks fine.", 0)).toBeTruthy();
  });

  test("code the agent is proposing is not a claim about having read it", () => {
    // Writing an example that mentions a filename must not read as evidence of
    // having opened one.
    const answer = "Here is what I would write:\n```ts\n// src/index.ts\nexport const x = 1;\n```";
    expect(unsourcedWarning(answer, 0)).toBeNull();
  });
});

describe("what counts as a path", () => {
  test("the shapes that matter", () => {
    expect(claimedPath("look at D:\\proj\\a.ts")).toBe("D:\\proj\\a.ts");
    expect(claimedPath("check /etc/nginx/nginx.conf please")).toBe("/etc/nginx/nginx.conf");
    expect(claimedPath("it lives in src/core/loop.ts")).toBe("src/core/loop.ts");
    expect(claimedPath("REPORT.md has the table")).toBe("REPORT.md");
  });

  test("prose about files in general is not a path", () => {
    expect(claimedPath("I checked the configuration and the tests")).toBeNull();
    expect(claimedPath("version 2026.8.1")).toBeNull();
  });
});
