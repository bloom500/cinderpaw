/**
 * request_secret (spec 2026-09-24 §6.2): the model asks for a secret, the
 * browser shows a password card, the page saves the value straight to the
 * engine, and the model only ever learns { field, saved }.
 */
import { expect, test } from "bun:test";
import { createRequestSecretTool } from "../src/tools/builtin/request-secret.ts";
import type { AskUserAnswer, AskUserQuestion, ToolContext } from "../src/types.ts";

function ctxWith(answer: string | Error, asked: AskUserQuestion[][] = []): ToolContext {
  return {
    sessionId: "chat",
    askUser: {
      ask: async (qs: AskUserQuestion[]): Promise<AskUserAnswer[]> => {
        asked.push(qs);
        if (answer instanceof Error) throw answer;
        return [{ question: qs[0]!.question, selected: [answer] }];
      },
      cancel: () => {},
    },
  } as unknown as ToolContext;
}

const args = { purpose: "Your Discord bot token, so I can talk there.", connector: "discord", field: "DISCORD_TOKEN" };

test("on a surface without cards it says so and asks nothing", async () => {
  const asked: AskUserQuestion[][] = [];
  const tool = createRequestSecretTool({ hasCards: () => false, isPresent: async () => false });
  const res = await tool.execute(args, ctxWith("Saved", asked));
  expect(res.ok).toBe(false);
  expect(res.content).toContain("unsupported_surface");
  expect(asked.length).toBe(0);
});

test("in the browser it asks with a secret card and returns only { field, saved }", async () => {
  const asked: AskUserQuestion[][] = [];
  const tool = createRequestSecretTool({ hasCards: () => true, isPresent: async (c, f) => c === "discord" && f === "DISCORD_TOKEN" });
  const res = await tool.execute(args, ctxWith("Saved", asked));
  expect(asked[0]![0]!.secret).toEqual({ connector: "discord", field: "DISCORD_TOKEN" });
  expect(res.ok).toBe(true);
  expect(JSON.parse(res.content)).toEqual({ field: "DISCORD_TOKEN", saved: true });
});

test("a Saved answer is checked against what was really stored", async () => {
  const tool = createRequestSecretTool({ hasCards: () => true, isPresent: async () => false });
  const res = await tool.execute(args, ctxWith("Saved"));
  expect(JSON.parse(res.content)).toEqual({ field: "DISCORD_TOKEN", saved: false });
});

test("cancel and a dismissed card both come back as not saved", async () => {
  const tool = createRequestSecretTool({ hasCards: () => true, isPresent: async () => true });
  expect(JSON.parse((await tool.execute(args, ctxWith("Cancel"))).content).saved).toBe(false);
  expect(JSON.parse((await tool.execute(args, ctxWith(new Error("cancelled")))).content).saved).toBe(false);
});

test("an unknown connector or a field it does not have is refused", async () => {
  const tool = createRequestSecretTool({ hasCards: () => true, isPresent: async () => true });
  expect((await tool.execute({ ...args, connector: "nope" }, ctxWith("Saved"))).ok).toBe(false);
  expect((await tool.execute({ ...args, field: "OPENAI_API_KEY" }, ctxWith("Saved"))).ok).toBe(false);
});
