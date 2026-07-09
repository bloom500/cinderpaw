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
    expect(out).toEqual({ response: "Paris", tokens: 42 });
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
  test("decompositionDepth=0 issues a single call", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    await invoke("x", makeGenome({ decompositionDepth: 0 }));
    expect(router.calls.length).toBe(1);
  });

  test("decompositionDepth=1 issues 2 parallel calls, joined with blank lines", async () => {
    const router = new FakeRouter();
    router.setNextResponses([
      { content: "part-a", totalTokens: 5 },
      { content: "part-b", totalTokens: 7 },
    ]);
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    const out = await invoke("x", makeGenome({ decompositionDepth: 1 }));
    expect(router.calls.length).toBe(2);
    expect(out.response).toBe("part-a\n\npart-b");
    expect(out.tokens).toBe(5 + 7);
  });

  test("each sub-call is prefixed [Part k/N]", async () => {
    const router = new FakeRouter();
    router.setNextResponses([
      { content: "x", totalTokens: 1 },
      { content: "y", totalTokens: 1 },
      { content: "z", totalTokens: 1 },
    ]);
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
    });
    await invoke("base", makeGenome({ decompositionDepth: 2 }));
    expect(router.calls.length).toBe(3);
    expect(router.calls[0]!.messages[1]!.content).toBe("[Part 1/3]\nbase");
    expect(router.calls[1]!.messages[1]!.content).toBe("[Part 2/3]\nbase");
    expect(router.calls[2]!.messages[1]!.content).toBe("[Part 3/3]\nbase");
  });

  test("decompositionDepth is capped at maxDecomposition", async () => {
    const router = new FakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      maxDecomposition: 2,
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
