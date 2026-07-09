/**
 * L4 Architecture — B5: live call-site wiring (spec §1, §6).
 *
 * Contract under test:
 *   - retrieval mapping round-trip is lossless for builtin hits (AC10:
 *     with no module promoted the recall tool sees identical data);
 *   - a malformed module reply degrades to empty hits, never a throw;
 *   - planner: invoke-agent consults `plan` only when decomposition
 *     splits; module steps replace the `[Part k/N]` prompts; a malformed
 *     reply falls back to the builtin split byte-identically.
 */
import { describe, expect, test } from "bun:test";
import { makeInvokeAgent } from "../src/rsi/invoke-agent.ts";
import {
  builtinPlanSteps,
  hitsToItems,
  itemsToHits,
  repliesToSteps,
} from "../src/rsi/seam-runtime.ts";
import type { GenomeSpec } from "../src/rsi/population-manager.ts";

const GENOME = (depth: number): GenomeSpec =>
  ({
    id: "g1",
    config: {
      promptTemplateId: 0,
      systemPromptId: 0,
      retrievalStrategy: "episodic",
      temperature: 0.2,
      contextWindowUsage: 0.5,
      decompositionDepth: depth,
      toolPreferenceWeights: [],
    },
  }) as unknown as GenomeSpec;

function fakeRouter() {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
      prompts.push(req.messages[1]!.content);
      return { content: "ok", totalTokens: 1 } as never;
    },
  };
}

describe("retrieval mapping (§1.1)", () => {
  test("builtin hits round-trip losslessly", () => {
    const hits = [
      { leafId: 42, text: "first" },
      { leafId: 7, text: "second" },
    ];
    expect(itemsToHits(hitsToItems(hits), 5)).toEqual(hits);
  });

  test("scores are rank-descending", () => {
    const { items } = hitsToItems([
      { leafId: 1, text: "a" },
      { leafId: 2, text: "b" },
      { leafId: 3, text: "c" },
    ]);
    expect(items[0]!.score).toBeGreaterThan(items[1]!.score);
    expect(items[1]!.score).toBeGreaterThan(items[2]!.score);
  });

  test("malformed module replies degrade to empty / partial, never throw", () => {
    expect(itemsToHits(null, 5)).toEqual([]);
    expect(itemsToHits({ items: "nope" }, 5)).toEqual([]);
    expect(itemsToHits({ items: [{ text: 1 }, { text: "ok", sourceId: "x" }] }, 5)).toEqual([
      { leafId: -1, text: "ok" },
    ]);
    expect(itemsToHits({ items: [{ text: "a", sourceId: "3" }] }, 0)).toEqual([]);
  });
});

describe("planner mapping (§1.2)", () => {
  test("builtin steps mirror the historical [Part k/N] split", () => {
    const steps = builtinPlanSteps("do the thing", 2);
    expect(steps.map((s) => s.description)).toEqual([
      "[Part 1/2]\ndo the thing",
      "[Part 2/2]\ndo the thing",
    ]);
  });

  test("repliesToSteps validates shape", () => {
    expect(repliesToSteps(null)).toBeNull();
    expect(repliesToSteps({ steps: [] })).toBeNull();
    expect(repliesToSteps({ steps: [{ description: 5 }] })).toBeNull();
    expect(
      repliesToSteps({ steps: [{ description: "x", suggestedTools: ["a", 3] }] }),
    ).toEqual([{ description: "x", suggestedTools: ["a"] }]);
  });
});

describe("invoke-agent planner consultation", () => {
  test("depth 0 → plan is never consulted", async () => {
    const router = fakeRouter();
    let consulted = 0;
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      plan: async () => {
        consulted++;
        return null;
      },
    });
    await invoke("hello", GENOME(0));
    expect(consulted).toBe(0);
    expect(router.prompts).toEqual(["hello"]);
  });

  test("module steps replace the builtin split", async () => {
    const router = fakeRouter();
    const invoke = makeInvokeAgent({
      router,
      getSystemPrompt: () => "sys",
      plan: async ({ goal, maxDepth }) => {
        expect(goal).toBe("hello");
        expect(maxDepth).toBe(2);
        return [
          { description: "step one", suggestedTools: [] },
          { description: "step two", suggestedTools: [] },
        ];
      },
    });
    await invoke("hello", GENOME(1));
    expect(router.prompts.sort()).toEqual(["step one", "step two"]);
  });

  test("null / throwing plan falls back to the builtin split byte-identically", async () => {
    for (const plan of [async () => null, async () => Promise.reject(new Error("boom"))]) {
      const router = fakeRouter();
      const invoke = makeInvokeAgent({
        router,
        getSystemPrompt: () => "sys",
        plan: plan as never,
      });
      await invoke("hello", GENOME(1));
      expect(router.prompts.sort()).toEqual(["[Part 1/2]\nhello", "[Part 2/2]\nhello"]);
    }
  });
});
