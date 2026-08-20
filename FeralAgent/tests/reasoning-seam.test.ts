// Regression: some providers (MiniMax-M2) split a word across the
// reasoning_content / content boundary — the answer's first fragment ("Re" of
// "Rejection") arrives as the tail of reasoning_content, landing in the
// <think> block so the visible answer starts mid-word ("jection"). The cloud
// streamer holds back the trailing word-fragment of reasoning and stitches it
// into the answer when content continues the word. See inference-providers.ts
// (OpenAICompatibleProvider #stream, seam heal).

import { afterEach, describe, expect, it } from "bun:test";

import { OpenAICompatibleProvider } from "../src/egress/inference-providers.ts";
import type { InferenceRequest, ModelTarget } from "../src/types.ts";

const LT = "<";
const GT = ">";
const THINK_TAG = LT + "think" + GT;
const THINK_END = LT + "/" + "think" + GT;

const TARGET: ModelTarget = {
  provider: "minimax",
  model: "MiniMax-M2",
  baseUrl: "https://example.test/v1",
  apiKey: "k",
};

const REQ: Omit<InferenceRequest, "onToken"> & {
  onToken?: InferenceRequest["onToken"];
} = { messages: [{ role: "user", content: "hi" }], temperature: 0.7 };

// SSE body: one `data: {json}` line per delta, `[DONE]` terminator.
function sse(deltas: Array<Record<string, unknown>>): Response {
  const lines = deltas.map(
    (d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`,
  );
  lines.push("data: [DONE]\n\n");
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("")));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

let originalFetch: typeof fetch | null = null;
afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
});

async function stream(deltas: Array<Record<string, unknown>>): Promise<{ captured: string; content: string }> {
  const provider = new OpenAICompatibleProvider();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => sse(deltas)) as typeof fetch;
  const captured: string[] = [];
  const res = await provider.complete(TARGET, { ...REQ, onToken: (t) => captured.push(t) }, false);
  return { captured: captured.join(""), content: res.content };
}

const strip = (s: string) => s.replace(new RegExp(THINK_TAG + "[\\s\\S]*?" + THINK_END, "g"), "").trim();

describe("OpenAICompatibleProvider — reasoning/content seam heal", () => {
  it("stitches a word split across the boundary back into the answer", async () => {
    const { captured, content } = await stream([
      { reasoning_content: "The user is hurting. Be gentle. Re" },
      { content: "jection" },
      { content: "-ul suxa." },
      { content: "", finish_reason: "stop" },
    ]);
    // "Re" moved out of the think block; visible answer is whole.
    expect(strip(captured)).toBe("Rejection-ul suxa.");
    expect(strip(content)).toBe("Rejection-ul suxa.");
    // "Re" is out of the think block, glued to the answer.
    expect(captured).toContain(THINK_END + "Rejection");
  });

  it("leaves a clean boundary alone (punctuation + capitalised fresh word)", async () => {
    const { captured } = await stream([
      { reasoning_content: "Let me think about this carefully." },
      { content: "Rejection hurts." },
      { content: "", finish_reason: "stop" },
    ]);
    expect(strip(captured)).toBe("Rejection hurts.");
    expect(captured).toContain("carefully." + THINK_END + "Rejection");
  });

  it("does not stitch when content starts with whitespace", async () => {
    const { captured } = await stream([
      { reasoning_content: "ok reasoning done" },
      { content: " Yes, absolutely." },
      { content: "", finish_reason: "stop" },
    ]);
    expect(strip(captured)).toBe("Yes, absolutely.");
    // "done" stayed inside reasoning.
    expect(captured).toContain("done" + THINK_END);
  });

  it("all-reasoning turn: held tail flushes inside the closed block", async () => {
    const { captured, content } = await stream([
      { reasoning_content: "only reasoning noAnswerWord" },
      { content: "", finish_reason: "stop" },
    ]);
    expect(strip(captured)).toBe("");
    expect(content).toBe(THINK_TAG + "only reasoning noAnswerWord" + THINK_END);
  });

  // The seam tests used to be ASCII throughout, and so was the heuristic:
  // `/^[a-z0-9]/` does not match "ă", so a Romanian word split across the
  // boundary never healed. The answer began mid-word and the first fragment
  // stayed stranded inside <think> — on every provider that streams reasoning
  // separately, in every language whose letters live outside A-Z.
  it("stitches a Romanian word split across the boundary", async () => {
    const { captured, content } = await stream([
      { reasoning_content: "Utilizatorul întreabă ceva. Ne gândim. Stăte" },
      { content: "ăm pe pagina aceea." },
      { content: "", finish_reason: "stop" },
    ]);
    expect(strip(captured)).toBe("Stăteăm pe pagina aceea.");
    expect(strip(content)).toBe("Stăteăm pe pagina aceea.");
    expect(captured).toContain(THINK_END + "Stăte");
  });

  it("stitches a Cyrillic word too — the rule is Unicode, not one language", async () => {
    const { captured } = await stream([
      { reasoning_content: "Думаем. Отве" },
      { content: "тим сейчас." },
      { content: "", finish_reason: "stop" },
    ]);
    expect(strip(captured)).toBe("Ответим сейчас.");
  });

  it("still refuses to stitch when the answer starts a fresh capitalised word", async () => {
    const { captured } = await stream([
      { reasoning_content: "Ne gândim atent." },
      { content: "Răspunsul este da." },
      { content: "", finish_reason: "stop" },
    ]);
    // Unicode-aware must not mean stitch-everything: an uppercase start is a
    // new word in any alphabet.
    expect(strip(captured)).toBe("Răspunsul este da.");
    expect(captured).toContain("atent." + THINK_END + "Răspunsul");
  });
});
