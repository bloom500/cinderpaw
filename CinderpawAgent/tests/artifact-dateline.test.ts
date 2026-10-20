import { describe, expect, it } from "bun:test";
import { withDateline } from "../src/tools/builtin/artifact.ts";

const at = new Date(2026, 9, 20, 16, 20);
// In the computer's own language, whatever the machine running the tests uses.
const when = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(at);

describe("a written document says when, and for whom", () => {
  it("puts the date and the name under the title", () => {
    expect(withDateline("# Plan\n\nIntro.\n\n## Day 1\n\n[[Day 1]]", "Darius Reteghi", at)).toBe(
      `# Plan\n\n_${when} · Darius Reteghi_\n\nIntro.\n\n## Day 1\n\n[[Day 1]]`,
    );
  });

  it("before onboarding, says the date alone", () => {
    expect(withDateline("# Plan\nIntro.", "  ", at)).toBe(`# Plan\n\n_${when}_\n\nIntro.`);
  });

  it("a document without a title starts with it", () => {
    expect(withDateline("Just notes.", "Ana", at)).toBe(`_${when} · Ana_\n\nJust notes.`);
  });
});
