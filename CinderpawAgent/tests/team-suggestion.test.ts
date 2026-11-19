import { expect, test } from "bun:test";
import { createSuggestTeamTool } from "../src/tools/builtin/suggest-team.ts";
import type { AskUserQuestion, ToolContext } from "../src/types.ts";
import { parseChannelAnswers } from "../src/core/ask-user-channel.ts";

const need = "I use Cinderpaw to research suppliers and track prices.";
const teammates = [
  { name: "Research", role: "Find suppliers", instructions: "Find local suppliers.", tools: [] },
  { name: "Prices", role: "Compare prices", instructions: "Compare the listed prices.", tools: [] },
];

function setup(answer: string, beforeAnswer?: () => void) {
  const cards: AskUserQuestion[] = [];
  const created: unknown[] = [];
  let owner = true;
  let text = "";
  const tool = createSuggestTeamTool({
    latestUserText: () => text,
    isOwner: () => owner,
    hasTeammates: () => false,
    create: (team) => { created.push(...team); },
  });
  const ctx = { sessionId: "owner", askUser: { ask: async ([question]: AskUserQuestion[]) => {
    cards.push(question);
    beforeAnswer?.();
    return parseChannelAnswers([question], answer);
  } } } as ToolContext;
  return { cards, created, text: (value: string) => { text = value; }, revoke: () => { owner = false; },
    propose: (quote = need) => tool.execute({ need: quote, teammates }, ctx) };
}

test.each([
  "Vreau un research pe site-ul TrustMRR ca să văd ce tipuri de aplicații bazate pe AI produc bani.",
  "Research the AI apps on TrustMRR and report which categories earn the most.",
  "Compare AI app categories by revenue and include sources for the top three.",
])("a concrete research request can offer a colleague before anyone is created: %s", async (request) => {
  const h = setup("Not now");
  h.text(request);
  expect((await h.propose(request)).ok).toBe(true);
  expect(h.cards[0].options.map(({ label }) => label)).toEqual(["Yes", "Not now"]);
  expect(h.created).toHaveLength(0);
  await h.propose(request);
  expect(h.cards).toHaveLength(1);
});

test.each(["Translate the word research into Romanian.", "What does market research mean?", "Find the time in Bucharest.", "Research is part of my degree."])(
  "keeps incidental mentions and simple lookups in the main chat: %s", async (request) => {
    const h = setup("Yes");
    h.text(request);
    expect((await h.propose(request)).ok).toBe(false);
    expect(h.cards).toHaveLength(0);
  },
);

test("a proposed need must come from the person's message", async () => {
  const h = setup("yes");
  h.text("Hello!");
  expect((await h.propose()).ok).toBe(false);
  expect(h.cards).toHaveLength(0);
  expect(h.created).toHaveLength(0);
});

test("Yes makes exactly the named teammates", async () => {
  const h = setup("Yes");
  h.text(need);
  expect((await h.propose()).ok).toBe(true);
  expect(h.cards[0].options.map((o) => o.label)).toEqual(["Yes", "Not now"]);
  expect(h.created).toEqual(teammates);
});

test("Not now makes no teammates", async () => {
  const h = setup("Not now");
  h.text(need);
  await h.propose();
  expect(h.created).toHaveLength(0);
});

test("a non-owner cannot accept a proposal", async () => {
  const h = setup("Yes");
  h.text(need);
  h.revoke();
  expect((await h.propose()).ok).toBe(false);
  expect(h.cards).toHaveLength(0);
  expect(h.created).toHaveLength(0);
});

test("checks ownership again after the answer arrives", async () => {
  const h = setup("yes", () => h.revoke());
  h.text(need);
  await h.propose();
  expect(h.cards).toHaveLength(1);
  expect(h.created).toHaveLength(0);
});
