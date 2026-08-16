/**
 * Module D — summarize.ts (TDD).
 *
 * Verifies the prompt contract (items appear in the prompt), trim contract
 * (no leading/trailing whitespace), and cap contract (output never exceeds
 * the configured ceiling — measured by chars since the local tokenizer is
 * the same one the prod path uses; the cap is a hard safety net, not the
 * primary governor, which is the LLM's `maxTokens`).
 *
 * All tests inject a mock `InferFn` — no real model calls.
 */
import { describe, it, expect } from "bun:test";
import {
  summarizeCluster,
  routerInfer,
  type InferFn,
} from "../src/memory/fractal/summarize.ts";
import { InferenceSpendAuthority } from "../src/egress/inference-spend-authority.ts";
import type { InferenceRouter } from "../src/egress/inference-router.ts";
import type { InferenceRequest } from "../src/types.ts";

/** Helper: a deterministic mock `InferFn` that records the prompt it received. */
function mockInfer(respond: (prompt: string) => string): InferFn & {
  prompts: string[];
} {
  const prompts: string[] = [];
  const fn = ((prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve(respond(prompt));
  }) as InferFn & { prompts: string[] };
  fn.prompts = prompts;
  return fn;
}

describe("summarizeCluster — prompt", () => {
  it("includes every item in the prompt, numbered", async () => {
    const inf = mockInfer(() => "summary text");
    await summarizeCluster(
      ["first item", "second item", "third item"],
      inf,
    );
    expect(inf.prompts).toHaveLength(1);
    const prompt = inf.prompts[0]!;
    expect(prompt).toContain("first item");
    expect(prompt).toContain("second item");
    expect(prompt).toContain("third item");
    // Numbered markers so the model can refer back unambiguously.
    expect(prompt).toContain("1.");
    expect(prompt).toContain("2.");
    expect(prompt).toContain("3.");
  });

  it("asks for a ≤200-token summary explicitly in the prompt", async () => {
    const inf = mockInfer(() => "summary");
    await summarizeCluster(["only item"], inf);
    const prompt = inf.prompts[0]!;
    expect(prompt).toMatch(/200/); // "200 tokens" appears verbatim in the instruction
  });
});

describe("summarizeCluster — trim", () => {
  it("trims leading and trailing whitespace from the model's output", async () => {
    const inf = mockInfer(() => "   padded summary text   \n\n");
    const out = await summarizeCluster(["x"], inf);
    expect(out).toBe("padded summary text");
  });

  it("returns empty string if the model returns only whitespace", async () => {
    const inf = mockInfer(() => "   \n\t  \n");
    const out = await summarizeCluster(["x"], inf);
    expect(out).toBe("");
  });
});

describe("summarizeCluster — cap", () => {
  it("never returns output longer than the character cap", async () => {
    const huge = "a".repeat(10_000);
    const inf = mockInfer(() => huge);
    const out = await summarizeCluster(["x"], inf);
    // The hard cap is 4 chars/token * 200 tokens = 800 chars (over-budget).
    // Real ceiling is whatever summarize.ts advertises in its constants.
    expect(out.length).toBeLessThanOrEqual(800);
    // And the cap should still keep content if the model returned a normal-length
    // answer (i.e. we don't over-truncate small outputs).
    const small = mockInfer(() => "Short and to the point.");
    const smallOut = await summarizeCluster(["x"], small);
    expect(smallOut).toBe("Short and to the point.");
  });

  it("cap does not break a multi-word summary in the middle of a word when not needed", async () => {
    const inf = mockInfer(() => "this is a normal summary");
    const out = await summarizeCluster(["x"], inf);
    expect(out).toBe("this is a normal summary");
  });
});

describe("summarizeCluster — empty input", () => {
  it("throws on an empty items array (programmer error — caller must check)", async () => {
    const inf = mockInfer(() => "should not be called");
    await expect(summarizeCluster([], inf)).rejects.toThrow(/empty/i);
    expect(inf.prompts).toHaveLength(0);
  });
});

describe("routerInfer — autonomous scope", () => {
  it("threads the rebuild spend authority and cancellation signal to the router", async () => {
    let request: InferenceRequest | undefined;
    const router = {
      isPrimaryLocal: true,
      currentModel: { provider: "local", model: "local", baseUrl: "http://127.0.0.1:11435" },
      complete: async (req: InferenceRequest) => {
        request = req;
        return { content: "summary", totalTokens: 1, promptTokens: 1, completionTokens: 0, model: "local", usedFallback: false };
      },
    } as unknown as InferenceRouter;
    const authority = new InferenceSpendAuthority({ maxCostUsd: 0, pricePer1kUsd: () => null });
    const controller = new AbortController();

    await routerInfer(router, { spendAuthority: authority, signal: controller.signal })("prompt");

    expect(request?.spendAuthority).toBe(authority);
    expect(request?.signal).toBe(controller.signal);
  });
});
