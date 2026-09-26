/**
 * Eval may only reward what reaches the live agent.
 *
 * `LIVE_REACH` marks `contextWindowUsage` "dropped": the live agent never
 * reads it. Mutation was frozen for it, but the eval harness still turned it
 * into the completion budget (`maxTokens = budget * usage`), and the four
 * seeds carry different values (0.4 / 0.5 / 0.7 / 0.9), which crossover
 * averages and the taste layer nudges. So two genomes that are the SAME agent
 * live were graded with 409 vs 921 tokens of room — the lineage with more
 * room won on answers the other was cut off from, and the champion was
 * credited for a knob that does nothing for the user.
 */
import { describe, expect, test } from "bun:test";
import { makeInvokeAgent } from "../src/rsi/infra/invoke-agent.ts";
import type { InferenceRequest } from "../src/types.ts";
import type { GenomeSpec } from "../src/rsi/l1-config/population-manager.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

function genome(id: string, overrides: Partial<GenomeConfig>): GenomeSpec {
  return {
    id,
    generation: 0,
    lineage: [],
    config: {
      promptTemplateId: 0,
      temperature: 0.3,
      systemPromptId: 1,
      retrievalStrategy: "episodic",
      contextWindowUsage: 0.5,
      toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
      decompositionDepth: 0,
      ...overrides,
    },
  };
}

function recordingAgent() {
  const requests: InferenceRequest[] = [];
  const invoke = makeInvokeAgent({
    router: {
      complete: async (req) => {
        requests.push(req);
        return { content: "42", totalTokens: 3, promptTokens: 2, completionTokens: 1, model: "fake", usedFallback: false };
      },
    },
    getSystemPrompt: (id) => `style-${id}`,
    contextBudget: 1024,
  });
  return { invoke, requests };
}

describe("eval grades only the dimensions the live agent applies", () => {
  test("two genomes that differ only in contextWindowUsage get the same request", async () => {
    const { invoke, requests } = recordingAgent();
    await invoke("q", genome("narrow", { contextWindowUsage: 0.4 }));
    await invoke("q", genome("wide", { contextWindowUsage: 0.9 }));
    const [a, b] = requests;
    expect(a!.maxTokens).toBe(b!.maxTokens);
    expect(a!.messages).toEqual(b!.messages);
  });

  test("the applied dimensions still reach the request", async () => {
    const { invoke, requests } = recordingAgent();
    await invoke("q", genome("cool", { temperature: 0.1, systemPromptId: 2 }));
    expect(requests[0]!.temperature).toBe(0.1);
    expect(requests[0]!.messages[0]!.content).toBe("style-2");
  });
});
