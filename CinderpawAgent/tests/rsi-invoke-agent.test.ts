/**
 * Faza 1 — runEval real: the GenomeConfig → InferenceRouter adapter.
 *
 * `makeInvokeAgent` is the production `invokeAgent` the suite runner
 * (run-eval.ts) calls per (genome, spec) pair. It maps every field of
 * the genome's `GenomeConfig` onto a single InferenceRouter.complete()
 * call (or a parallel chain for `decompositionDepth > 0`) and returns
 * the router's content + totalTokens shape.
 *
 * Tests use a fake router that records every request and returns a
 * canned response so we can assert the mapping deterministically — no
 * model, no network, no live provider. E2E verification (real router,
 * real model, real cost) is a manual step left for the operator run.
 */

import { describe, expect, test } from "bun:test";
import {
  makeInvokeAgent,
  selectTools,
  MAX_DECOMPOSITION,
} from "../src/rsi/infra/invoke-agent.ts";
import type {
  InvokeRouter,
  InvokeTool,
} from "../src/rsi/infra/invoke-agent.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";
import type { GenomeSpec } from "../src/rsi/l1-config/population-manager.ts";
import type { InferenceRequest } from "../src/types.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.42,
  systemPromptId: 2,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 0,
};

function makeGenome(over: Partial<GenomeConfig> = {}, id = "g1"): GenomeSpec {
  return {
    id,
    generation: 0,
    lineage: [],
    config: { ...CFG, ...over },
  };
}

/** A fake router that records every call and returns a canned response. */
class FakeRouter implements InvokeRouter {
  readonly calls: InferenceRequest[] = [];
  private nextResponse: { content: string; totalTokens: number } = {
    content: "OK",
    totalTokens: 7,
  };
  private nextResponses: Array<{ content: string; totalTokens: number }> | null = null;

  setNextResponse(r: { content: string; totalTokens: number }): void {
    this.nextResponse = r;
    this.nextResponses = null;
  }

  /** Queue distinct responses for parallel (decomposition) sub-calls. */
  setNextResponses(rs: Array<{ content: string; totalTokens: number }>): void {
    this.nextResponses = rs;
  }

  async complete(req: InferenceRequest): Promise<{ content: string; totalTokens: number }> {
    this.calls.push(req);
    if (this.nextResponses && this.nextResponses.length > 0) {
      return this.nextResponses.shift()!;
    }
    return this.nextResponse;
  }
}

const SYSTEM_POOL: Record<number, string> = {
  0: "system-default",
  1: "system-curious",
  2: "system-rigorous",
};

describe("makeInvokeAgent — single-call mapping", () => {
  test("passes temperature through to InferenceRequest", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: (i) => SYSTEM_POOL[i] ?? "default",
    });
    await invoke("Capital of France?", makeGenome({ temperature: 0.13 }));
    expect(router.calls[0]!.temperature).toBe(0.13);
  });

  test("loads systemPromptId from the versioned pool", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: (i) => SYSTEM_POOL[i] ?? "default",
    });
    await invoke("x", makeGenome({ systemPromptId: 2 }));
    const sysMsg = router.calls[0]!.messages[0]!;
    expect(sysMsg.role).toBe("system");
    expect(sysMsg.content).toBe("system-rigorous");
  });

  test("places the spec prompt as the user message", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    await invoke("Capital of France?", makeGenome());
    const userMsg = router.calls[0]!.messages[1]!;
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("Capital of France?");
  });

  test("computes maxTokens as floor(budget * contextWindowUsage), clamped to 256", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      contextBudget: 4096,
    });
    await invoke("x", makeGenome({ contextWindowUsage: 0.5 })); // 0.5 * 4096 = 2048
    expect(router.calls[0]!.maxTokens).toBe(2048);

    // Floor 256: a low-usage genome must not truncate CORRECT answers
    // (tier2/plan_make_tea was cut at 130 tokens on usage 0.1 × 1024).
    await invoke("x", makeGenome({ contextWindowUsage: 0.1 })); // floor=409 > 256 → 409
    expect(router.calls[1]!.maxTokens).toBe(409);

    await invoke("x", makeGenome({ contextWindowUsage: 0.001 })); // floor=4 → clamped to 256
    expect(router.calls[2]!.maxTokens).toBe(256);
  });

  test("uses a stable session id per genome", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      sessionIdFor: (id) => `rsi-${id}`,
    });
    await invoke("x", makeGenome({}, "g42"));
    expect(router.calls[0]!.sessionId).toBe("rsi-g42");
  });

  test("default sessionId is rsi-eval-${genomeId}", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    await invoke("x", makeGenome({}, "g42"));
    expect(router.calls[0]!.sessionId).toBe("rsi-eval-g42");
  });
});

describe("makeInvokeAgent — recall injection", () => {
  test("without recall, the user message is the prompt as-is", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    await invoke("plain prompt", makeGenome());
    expect(router.calls[0]!.messages[1]!.content).toBe("plain prompt");
  });

  test("with recall, the user message carries a memory context block", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      recall: async ({ query }) => `[Memory context]\nfact about ${query}\n[End memory context]`,
    });
    await invoke("Capital of France?", makeGenome());
    const content = router.calls[0]!.messages[1]!.content;
    expect(content).toContain("[Memory context]");
    expect(content).toContain("fact about Capital of France?");
    expect(content).toContain("[End memory context]");
    // Recall block precedes the prompt.
    expect(content.indexOf("[Memory context]")).toBeLessThan(
      content.indexOf("Capital of France?"),
    );
  });

  test("the recall strategy name from the genome is forwarded", async () => {
    const router = new FakeRouter();
    const seen: Array<{ strategy: string; query: string }> = [];
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      recall: async (opts) => {
        seen.push({ strategy: opts.strategy, query: opts.query });
        return "ctx";
      },
    });
    await invoke("hello", makeGenome({ retrievalStrategy: "hybrid" }));
    expect(seen[0]).toEqual({ strategy: "hybrid", query: "hello" });
  });
});

describe("makeInvokeAgent — return shape", () => {
  test("returns {response: content, tokens: totalTokens}", async () => {
    const router = new FakeRouter();
    router.setNextResponse({ content: "Paris", totalTokens: 42 });
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    const out = await invoke("x", makeGenome());
    expect(out).toEqual({
      response: "Paris",
      tokens: 42,
      // A healthy answer is measured as answered. These two travel with
      // every response so the caller can tell "graded badly" from "never
      // got an answer to grade" — see AgentResponse.unanswered.
      unanswered: 0,
      reasoningOnly: false,
    });
  });

  test("an all-reasoning reply is retried with room, and the retry's answer wins", async () => {
    const router = new FakeRouter();
    // First call: the model thought until it ran out of tokens and said
    // nothing. This is the shape that produced 71% of eval iterations on
    // Darius's machine and was being graded as a wrong answer.
    router.setNextResponses([
      { content: "<think>hmm, the capital, let me consider</think>", totalTokens: 409 },
      { content: "Paris", totalTokens: 120 },
    ]);
    const invoke = makeInvokeAgent({ router, getSystemPrompt: () => "sys" });
    const out = await invoke("Capital of France?", makeGenome());

    expect(out.response).toBe("Paris");
    expect(out.unanswered).toBe(0);
    expect(out.reasoningOnly).toBe(false);
    // Both calls are billed: the reasoning tokens were really spent, and
    // the cost component of fitness has to see them.
    expect(out.tokens).toBe(529);
    expect(router.calls).toHaveLength(2);
    // The retry is what makes the answer possible: more room, less thinking.
    expect(router.calls[1]!.maxTokens).toBeGreaterThan(router.calls[0]!.maxTokens!);
    expect(router.calls[1]!.reasoningEffort).toBe("low");
  });

  test("still unanswered after the retry is reported, not silently scored", async () => {
    const router = new FakeRouter();
    router.setNextResponses([
      { content: "<think>a</think>", totalTokens: 400 },
      { content: "<think>b</think>", totalTokens: 800 },
    ]);
    const invoke = makeInvokeAgent({ router, getSystemPrompt: () => "sys" });
    const out = await invoke("x", makeGenome());

    expect(out.response).toBe("");
    expect(out.unanswered).toBe(1);
    expect(out.reasoningOnly).toBe(true);
    expect(router.calls).toHaveLength(2); // exactly one retry, never a loop
  });

  test("a genuinely empty body is NOT retried", async () => {
    // No text at all means a dead route, a wrong model id or a refusal.
    // Retrying doubles the cost of a broken configuration and hides it.
    const router = new FakeRouter();
    router.setNextResponse({ content: "", totalTokens: 0 });
    const invoke = makeInvokeAgent({ router, getSystemPrompt: () => "sys" });
    const out = await invoke("x", makeGenome());

    expect(out.response).toBe("");
    expect(out.unanswered).toBe(1);
    expect(out.reasoningOnly).toBe(false); // the model produced nothing, not thoughts
    expect(router.calls).toHaveLength(1);
  });

  test("reasoningRetry: false restores the single-call behaviour", async () => {
    const router = new FakeRouter();
    router.setNextResponse({ content: "<think>only thoughts</think>", totalTokens: 300 });
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      reasoningRetry: false,
    });
    const out = await invoke("x", makeGenome());

    expect(out.response).toBe("");
    expect(router.calls).toHaveLength(1);
  });

  test("a router error propagates as a thrown error", async () => {
    const router: InvokeRouter = {
      complete: async () => {
        throw new Error("connection refused");
      },
    };
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    expect(invoke("x", makeGenome())).rejects.toThrow("connection refused");
  });

  test("a genome without a config throws (defensive — selection must set one)", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    const badGenome: GenomeSpec = {
      id: "g99",
      generation: 0,
      lineage: [],
      // config deliberately missing
    };
    expect(invoke("x", badGenome)).rejects.toThrow(/no config/);
  });
});

describe("makeInvokeAgent — decomposition", () => {
  /** A planner that really splits: one step per requested part. */
  const splitter = async (req: { goal: string; maxDepth: number }) =>
    Array.from({ length: req.maxDepth }, (_, k) => ({
      description: `step ${k + 1} of ${req.goal}`,
      suggestedTools: [],
    }));

  test("decompositionDepth=0 issues a single call", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    await invoke("x", makeGenome({ decompositionDepth: 0 }));
    expect(router.calls.length).toBe(1);
  });

  test("without a planner, ANY depth still issues one call with the prompt intact", async () => {
    // The bug this pins, measured live on the VPS: the builtin fallback
    // manufactured `n` copies of the same prompt under a `[Part k/N]` prefix
    // and joined the `n` identical answers, so a genome with depth 3 was
    // graded on `{"answer": 7} {"answer": 7} {"answer": 7} {"answer": 7}`.
    // Every Tier 0 format spec failed, the confidence gate rejected every
    // candidate, and nothing could ever be promoted — at 4x the tokens.
    // Splitting a prompt needs a planner; with none, do not split.
    const router = new FakeRouter();
    router.setNextResponses([{ content: '{"answer": 7}', totalTokens: 5 }]);
    const invoke = makeInvokeAgent({ router, getSystemPrompt: () => "sys" });
    const out = await invoke("What is 3 + 4?", makeGenome({ decompositionDepth: 3 }));
    expect(router.calls.length).toBe(1);
    expect(router.calls[0]!.messages[1]!.content).toBe("What is 3 + 4?");
    expect(out.response).toBe('{"answer": 7}');
  });

  test("a planner that fails does not cost the eval its answer", async () => {
    const router = new FakeRouter();
    router.setNextResponses([{ content: "answered anyway", totalTokens: 3 }]);
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      plan: async () => {
        throw new Error("planner module blew up");
      },
    });
    const out = await invoke("x", makeGenome({ decompositionDepth: 2 }));
    expect(router.calls.length).toBe(1);
    expect(out.response).toBe("answered anyway");
  });

  test("with a planner, depth=1 issues 2 parallel calls, joined with blank lines", async () => {
    const router = new FakeRouter();
    router.setNextResponses([
      { content: "part-a", totalTokens: 5 },
      { content: "part-b", totalTokens: 7 },
    ]);
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      plan: splitter,
    });
    const out = await invoke("x", makeGenome({ decompositionDepth: 1 }));
    expect(router.calls.length).toBe(2);
    expect(out.response).toBe("part-a\n\npart-b");
    expect(out.tokens).toBe(5 + 7);
  });

  test("the planner's steps ARE the sub-prompts", async () => {
    const router = new FakeRouter();
    router.setNextResponses([
      { content: "x", totalTokens: 1 },
      { content: "y", totalTokens: 1 },
      { content: "z", totalTokens: 1 },
    ]);
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      plan: splitter,
    });
    await invoke("base", makeGenome({ decompositionDepth: 2 }));
    expect(router.calls.length).toBe(3);
    expect(router.calls.map((c) => c.messages[1]!.content)).toEqual([
      "step 1 of base",
      "step 2 of base",
      "step 3 of base",
    ]);
  });

  test("decompositionDepth is capped at maxDecomposition", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      maxDecomposition: 2,
      plan: splitter,
    });
    await invoke("x", makeGenome({ decompositionDepth: 10 }));
    expect(router.calls.length).toBe(2);
  });

  test("sub-calls get distinct session ids so router accounting doesn't conflate", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      sessionIdFor: (id) => `rsi-${id}`,
      plan: splitter,
    });
    await invoke("x", makeGenome({ decompositionDepth: 2 }, "g7"));
    const ids = router.calls.map((c) => c.sessionId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("rsi-g7");
    expect(ids[1]).toBe("rsi-g7#p2");
    expect(ids[2]).toBe("rsi-g7#p3");
  });

  test("MAX_DECOMPOSITION default caps depth-driven sub-calls", () => {
    // Sanity: the constant exists and is a sensible positive integer.
    expect(MAX_DECOMPOSITION).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(MAX_DECOMPOSITION)).toBe(true);
  });
});

describe("selectTools", () => {
  const tools: InvokeTool[] = [
    { name: "read_file", nativeShape: { n: "read_file" }, openAIShape: { f: "read_file" } },
    { name: "web_search", nativeShape: { n: "web_search" }, openAIShape: { f: "web_search" } },
    { name: "git_diff", nativeShape: { n: "git_diff" }, openAIShape: { f: "git_diff" } },
    { name: "delegate_task", nativeShape: { n: "delegate_task" }, openAIShape: { f: "delegate_task" } },
  ];

  test("returns the weights-sorted subset (highest first)", () => {
    const { nativeTools, openAITools } = selectTools(tools, [0.1, 0.4, 0.3, 0.2]);
    expect(nativeTools.map((s: { n: string }) => s.n)).toEqual([
      "web_search",
      "git_diff",
      "delegate_task",
      "read_file",
    ]);
    expect(openAITools.map((s: { f: string }) => s.f)).toEqual([
      "web_search",
      "git_diff",
      "delegate_task",
      "read_file",
    ]);
  });

  test("drops tools whose weight is 0 or negative", () => {
    const { nativeTools } = selectTools(tools, [0, 0, 0.5, 0]);
    expect(nativeTools).toHaveLength(1);
  });

  test("missing weights are treated as 0 (dropped)", () => {
    const { nativeTools } = selectTools(tools, [0.6]);
    expect(nativeTools).toHaveLength(1);
    expect((nativeTools[0] as { n: string }).n).toBe("read_file");
  });

  test("empty tool registry yields empty lists", () => {
    const { nativeTools, openAITools } = selectTools([], [0.25, 0.25, 0.25, 0.25]);
    expect(nativeTools).toEqual([]);
    expect(openAITools).toEqual([]);
  });

  test("tools without native/openai shapes contribute to neither list", () => {
    const bare: InvokeTool[] = [{ name: "manual_tool" }];
    const { nativeTools, openAITools } = selectTools(bare, [1]);
    expect(nativeTools).toEqual([]);
    expect(openAITools).toEqual([]);
  });
});

describe("makeInvokeAgent — the grader sees the answer, not the reasoning", () => {
  // Regression: on the VPS every candidate breached the Tier 0 sanity floor
  // ("6 frozen sanity task(s) failed") because MiniMax-M3's chat template bakes
  // the opening <think> into the prompt, so completions arrive as
  // "reasoning…</think>answer" and Tier 0 graded the raw string. Nothing could
  // ever be promoted — the gate was rejecting the grader's mistake, not the
  // candidate. The strings below are copied from the real failing eval logs.
  const invokeWith = (router: InvokeRouter) =>
    makeInvokeAgent({ router, getSystemPrompt: () => "sys" });

  test("strips a MiniMax orphan-close response (tier0/json_format)", async () => {
    const router = new FakeRouter();
    router.setNextResponse({
      content:
        '<think>7</think> {"answer": 7} <think>The user wants a JSON object with an "answer" key</think>',
      totalTokens: 847,
    });
    const res = await invokeWith(router)("How many days in a week?", makeGenome());
    expect(res.response).toBe('{"answer": 7}');
  });

  test("strips a leading reasoning block (tier0/constraint_count)", async () => {
    const router = new FakeRouter();
    router.setNextResponse({
      content:
        "<think>The user is asking me to reply with exactly 5 words. But I need to be careful.</think>\nOne two three four five",
      totalTokens: 2593,
    });
    const res = await invokeWith(router)("Reply with EXACTLY 5 words", makeGenome());
    expect(res.response).toBe("One two three four five");
  });

  test("token count still includes the reasoning tokens — they were spent", async () => {
    const router = new FakeRouter();
    router.setNextResponse({
      content: "<think>a long deliberation</think>ok",
      totalTokens: 4242,
    });
    const res = await invokeWith(router)("x", makeGenome());
    expect(res.tokens).toBe(4242);
  });

  test("a response truncated mid-reasoning yields no answer, and fails honestly", async () => {
    const router = new FakeRouter();
    router.setNextResponse({
      content: "<think>I should start by considering",
      totalTokens: 100,
    });
    const res = await invokeWith(router)("x", makeGenome());
    expect(res.response).toBe("");
  });

  test("a clean answer is passed through untouched", async () => {
    const router = new FakeRouter();
    router.setNextResponse({ content: '{"answer": 7}', totalTokens: 12 });
    const res = await invokeWith(router)("x", makeGenome());
    expect(res.response).toBe('{"answer": 7}');
  });

  test("strips each sub-response separately when decomposing", async () => {
    // Stripping after the join would let a dangling <think> in part 1 swallow
    // every later part's answer.
    const router = new FakeRouter();
    router.setNextResponses([
      { content: "<think>hmm", totalTokens: 10 },
      { content: "<think>ok</think>second answer", totalTokens: 20 },
    ]);
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      // Decomposition only happens when a planner produces the parts.
      plan: async (req) => [
        { description: `a ${req.goal}`, suggestedTools: [] },
        { description: `b ${req.goal}`, suggestedTools: [] },
      ],
    });
    const res = await invoke("x", makeGenome({ decompositionDepth: 1 }));
    expect(res.response).toContain("second answer");
    expect(res.response).not.toContain("hmm");
  });
});
