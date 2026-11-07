/**
 * A bare turn: the same model, with none of Cinderpaw around it. Used to film
 * "the model alone vs the model inside Cinderpaw" from one app, so the only
 * honest version is one where NOTHING of the harness reaches the model.
 */

import { describe, expect, test } from "bun:test";
import { runBareTurn } from "../src/core/bare-turn.ts";
import type { InferenceRequest, OutboundEvent } from "../src/types.ts";

function fakeRouter(reply: string | Error) {
  const seen: InferenceRequest[] = [];
  return {
    seen,
    async complete(req: InferenceRequest) {
      seen.push(req);
      if (reply instanceof Error) throw reply;
      for (const piece of reply.match(/.{1,4}/gs) ?? []) req.onToken?.(piece);
      return { content: reply, promptTokens: 5, completionTokens: 3, totalTokens: 8, model: "terra", usedFallback: false };
    },
  };
}

describe("bare turn", () => {
  test("the model gets the person's words and nothing else: no prompt, no tools", async () => {
    const router = fakeRouter("<html>voxels</html>");
    await runBareTurn(router, { sessionId: "s", messageId: "m", text: "Build a voxel village", emit: () => {} });
    const req = router.seen[0]!;
    expect(req.messages).toEqual([{ role: "user", content: "Build a voxel village" }]);
    expect(req.nativeTools).toBeUndefined();
    expect(req.openAITools).toBeUndefined();
  });

  test("the model's own settings still apply: effort, temperature, max tokens", async () => {
    const router = fakeRouter("ok");
    await runBareTurn(router, {
      sessionId: "s", messageId: "m", text: "hi", emit: () => {},
      inferParams: { effort: "high", temperature: 0.3, max_tokens: 4000 },
    });
    const req = router.seen[0]!;
    expect(req.reasoningEffort).toBe("high");
    expect(req.temperature).toBe(0.3);
    expect(req.maxTokens).toBe(4000);
  });

  test("it streams like any reply, then says done with the whole answer", async () => {
    const events: OutboundEvent[] = [];
    await runBareTurn(fakeRouter("abcdefgh"), { sessionId: "s", messageId: "m", text: "hi", emit: (e) => events.push(e) });
    const chunks = events.filter((e) => e.type === "chunk").map((e) => (e as { content: string }).content);
    expect(chunks.join("")).toBe("abcdefgh");
    const done = events.at(-1) as Extract<OutboundEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.content).toBe("abcdefgh");
    expect(done.incomplete).toBe(false);
  });

  test("an afterword is Cinderpaw's line for the person, added after the model is done", async () => {
    const events: OutboundEvent[] = [];
    const router = fakeRouter("```html\n<p>hi</p>\n```");
    await runBareTurn(router, {
      sessionId: "s", messageId: "m", text: "hi", emit: (e) => events.push(e),
      afterword: async (answer) => (answer.includes("```html") ? "Open it as a page: http://127.0.0.1:1/p/x" : undefined),
    });
    // The model was asked once and never saw the line.
    expect(router.seen.length).toBe(1);
    const done = events.at(-1) as Extract<OutboundEvent, { type: "done" }>;
    expect(done.content).toEndWith("Open it as a page: http://127.0.0.1:1/p/x");
  });

  test("a failed call ends the turn in words instead of hanging", async () => {
    const events: OutboundEvent[] = [];
    await runBareTurn(fakeRouter(new Error("429 rate limited")), { sessionId: "s", messageId: "m", text: "hi", emit: (e) => events.push(e) });
    const done = events.at(-1) as Extract<OutboundEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.content).toContain("did not answer");
    expect(done.diagnostic).toContain("429");
  });
});
