import { describe, expect, it } from "bun:test";
import { AskUserBridgeImpl } from "../src/core/ask-user-bridge.ts";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { createAskUserTool } from "../src/tools/builtin/ask-user.ts";

describe("ask_user forced escalation", () => {
  for (const { reply, format } of [
    { reply: "1", format: null },
    { reply: "1, ", format: null },
    { reply: "1,,1", format: null },
    { reply: "1\n\n1", format: null },
    { reply: "1\r\n\r\n1", format: null },
    { reply: "1, 2", format: "Brief" },
    { reply: "1,2,2", format: "Full" },
    { reply: "1\r\n2\r\n2", format: "Full" },
  ]) {
    it(`requires an explicit channel answer for the escalated question (${JSON.stringify(reply)})`, async () => {
      const router = new ChannelAskRouter(1000);
      router.registerSender("discord", async () => {});
      const bridge = new AskUserBridgeImpl(() => {});
      bridge.setDelegate(router);
      const tool = createAskUserTool();
      const resultPromise = tool.execute({ questions: [
        { question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] },
        {
          question: "Publish the report?",
          options: [{ label: "Publish", recommended: true }, { label: "Wait" }],
          force_escalate: true,
        },
        { question: "Which format?", options: [{ label: "Brief" }, { label: "Full" }] },
      ] }, {
        sessionId: "discord:partial-test",
        manifest: tool.manifest,
        fetch: (() => Promise.reject(new Error("not used"))) as never,
        audit: () => {},
        askUser: bridge,
      });
      router.handleInbound("discord:partial-test", reply);
      const result = await resultPromise;
      if (format !== null) {
        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
          autoResolved: false,
          answers: [
            { question: "Which color?", selected: ["Red"] },
            { question: "Publish the report?", selected: ["Wait"] },
            { question: "Which format?", selected: [format] },
          ],
        });
        return;
      }
      expect(result.ok).toBe(false);
      expect(result.error).toBe("ask_user_failed");
      expect(result.content).toMatch(/human/);
      expect(result.data).toBeUndefined();
      expect(router.pendingCount).toBe(0);
    });
  }

  for (const autonomous of ["false", "true"]) {
    for (const flag of ["force_escalate", "forceEscalate"]) {
      for (const transport of ["desktop", "channel"]) {
        it(`requires a human for a mixed batch (${transport}, autonomous=${autonomous}, ${flag})`, async () => {
          const previous = process.env.CINDERPAW_AUTONOMOUS;
          process.env.CINDERPAW_AUTONOMOUS = autonomous;
          const bridge = new AskUserBridgeImpl(() => {}, { timeoutMs: 10 });
          const sent: string[] = [];
          if (transport === "channel") {
            const router = new ChannelAskRouter(10);
            router.registerSender("discord", async (_session, text) => { sent.push(text); });
            bridge.setDelegate(router);
          }
          try {
            const tool = createAskUserTool();
            const result = await tool.execute({
              questions: [
                { question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] },
                {
                  question: "Publish the report?",
                  options: [{ label: "Publish", recommended: true }, { label: "Wait" }],
                  [flag]: true,
                },
              ],
            }, {
              sessionId: "discord:escalation-test",
              manifest: tool.manifest,
              fetch: (() => Promise.reject(new Error("not used"))) as never,
              audit: () => {},
              askUser: bridge,
            });
            expect(result.ok).toBe(false);
            expect(result.error).toBe("escalation_required");
            expect(result.data).toBeUndefined();
            expect(result.content).toMatch(/human/);
            if (transport === "channel") {
              expect(sent).toHaveLength(2);
              expect(sent[1]).not.toContain("going with the recommended option");
              expect(sent[1]).toMatch(/human/);
            }
          } finally {
            bridge.cancelAll("test cleanup");
            if (previous === undefined) delete process.env.CINDERPAW_AUTONOMOUS;
            else process.env.CINDERPAW_AUTONOMOUS = previous;
          }
        });
      }
    }
  }
});
