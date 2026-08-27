/**
 * What deep_research is told when it writes the report.
 *
 * The synthesis step used to carry one rule — "Do not invent facts beyond what
 * the notes contain" — and a real 2026-08-04 report broke it in three ways at
 * once: it reconstructed a plausible-looking config path that appeared in no
 * source, it quoted precise figures from an AI-generated wiki as settled fact,
 * and it had nowhere to put what the notes did not answer, so the gaps got
 * filled instead of reported.
 *
 * An abstract prohibition asks for a property nothing checks. These tests pin
 * the checkable replacements — per-sentence citations, no unsourced specifics,
 * source tiering, and a section where the gaps have to go — reaching the model
 * on the call that actually writes the report.
 */

import { describe, expect, test } from "bun:test";
import { ResearchLoop } from "../src/research/research-loop.ts";
import type { InferenceRequest, InferenceResponse, CinderpawFetch } from "../src/types.ts";
import type { InferenceRouter } from "../src/egress/inference-router.ts";

function reply(content: string): InferenceResponse {
  return {
    content,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    model: "fake",
    usedFallback: false,
  } as InferenceResponse;
}

/** Records every completion the loop asks for, and answers by role. */
function fakeRouter() {
  const calls: InferenceRequest[] = [];
  const router = {
    async complete(req: InferenceRequest): Promise<InferenceResponse> {
      calls.push(req);
      const system = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("research report")) return reply("# Report");
      if (system.includes("Extract the key research findings")) {
        return reply("- Their config lives in a file [source says so]");
      }
      // The planner: search once, then stop.
      const searched = calls.filter((c) =>
        (c.messages.find((m) => m.role === "system")?.content ?? "").includes("Extract the key"),
      ).length;
      return reply(searched > 0 ? '{"action":"synthesize"}' : '{"action":"search","query":"q"}');
    },
  } as unknown as InferenceRouter;
  return { router, calls };
}

/** Jina search returns two hits (so URL selection needs no model call). */
const fakeFetch: CinderpawFetch = async (url) => {
  const body = url.startsWith("https://s.jina.ai/")
    ? JSON.stringify({
        data: [
          { title: "Their repo", url: "https://example.com/repo", description: "x" },
          { title: "Some wiki", url: "https://example.com/wiki", description: "y" },
        ],
      })
    : "page text";
  return {
    status: 200,
    ok: true,
    headers: {},
    text: async () => body,
    json: async () => JSON.parse(body),
  };
};

/** The system prompt of the call that writes the final report. */
async function synthesisPrompt(): Promise<string> {
  const { router, calls } = fakeRouter();
  const loop = new ResearchLoop(router, fakeFetch, "s1", "fake-jina-key");
  await loop.run("what is their config path?", 1);
  const synth = calls.find((c) =>
    (c.messages.find((m) => m.role === "system")?.content ?? "").includes("research report"),
  );
  expect(synth, "the loop never reached synthesis").toBeDefined();
  return synth!.messages.find((m) => m.role === "system")!.content;
}

describe("deep_research synthesis brief", () => {
  test("a sentence without a citation must declare itself an inference", async () => {
    const prompt = await synthesisPrompt();
    expect(prompt).toMatch(/no citation is your own inference/i);
  });

  test("specific values may not be written unless a note contains them", async () => {
    const prompt = await synthesisPrompt();
    // The exact failure: a reconstructed config path that read as researched.
    expect(prompt).toMatch(/file paths, config keys, version numbers/i);
    expect(prompt).toMatch(/never reconstruct/i);
  });

  test("a wiki or AI-generated summary is ranked below the vendor's own source", async () => {
    const prompt = await synthesisPrompt();
    expect(prompt).toMatch(/AI-generated summary is secondary/i);
    expect(prompt).toMatch(/primary/i);
  });

  test("the report has a place for what the notes did not answer", async () => {
    const prompt = await synthesisPrompt();
    // Same principle as `cinderpaw migrate`'s "Not imported": a gap with nowhere to
    // go is a gap that gets filled in.
    expect(prompt).toMatch(/## Not confirmed/);
    expect(prompt).toMatch(/single secondary source/i);
  });

  test("the notes handed over carry their URL, so tiering is possible at all", async () => {
    const { router, calls } = fakeRouter();
    const loop = new ResearchLoop(router, fakeFetch, "s1", "fake-jina-key");
    await loop.run("q", 1);
    const synth = calls.find((c) =>
      (c.messages.find((m) => m.role === "system")?.content ?? "").includes("research report"),
    );
    const user = synth!.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("URL: https://example.com/");
  });
});
