/**
 * In the local web page the connector steps must never tell the agent to ask
 * for a paste: a token typed into the chat reaches the AI service. Seen live
 * 25 Sep: with the paste sentence still in the steps, the agent fell back to
 * it after the person pressed "Not now".
 */
import { expect, test } from "bun:test";
import { CATALOG, stepsFor } from "../src/tools/builtin/connectors-manage.ts";

const pasteWords = /paste it in this chat|send it to me in this chat|paste both tokens in this chat|paste the token in this chat|send me both/i;

test("with cards, no step asks for a paste; each points at request_secret", () => {
  for (const id of Object.keys(CATALOG)) {
    for (const step of stepsFor(id, true)) {
      expect(step).not.toMatch(pasteWords);
    }
  }
  const discord = stepsFor("discord", true).join(" ");
  expect(discord).toContain("request_secret");
  expect(discord).toContain("DISCORD_TOKEN");
});

test("without cards the steps are unchanged", () => {
  expect(stepsFor("discord", false)).toEqual(CATALOG.discord!.steps ?? []);
});
