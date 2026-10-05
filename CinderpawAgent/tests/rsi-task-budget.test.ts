/**
 * S1.3a of the AgentLoop evolution spec: the budget broker. Every model call
 * an executor makes passes through it; it counts tokens, tool calls and
 * dollars outside the executor and stops the task when a limit is reached.
 * A stopped task is a failed task, never one with a bigger budget.
 */
import { describe, expect, test } from "bun:test";
import { BudgetBroker, type BrokerModel, type ChatBody } from "../src/rsi/research/task-budget.ts";
import type { TaskBudget } from "../src/rsi/research/task-family.ts";

const budget = (over: Partial<TaskBudget> = {}): TaskBudget => ({
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  maxToolCalls: 3,
  maxWallMs: 60_000,
  maxUsd: 0,
  ...over,
});

/** A model that answers with fixed usage and records what reached it. */
function model(over: Partial<BrokerModel> & { usage?: { prompt_tokens?: number; completion_tokens?: number } | null; toolCalls?: number } = {}) {
  const seen: ChatBody[] = [];
  const m: BrokerModel = {
    id: "stub",
    usdPerMInput: 0,
    usdPerMOutput: 0,
    async call(body) {
      seen.push(body);
      const tool_calls = Array.from({ length: over.toolCalls ?? 0 }, (_, i) => ({
        id: `c${i}`,
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      }));
      return {
        choices: [{ message: { role: "assistant", content: "ok", ...(tool_calls.length ? { tool_calls } : {}) } }],
        ...(over.usage === null ? {} : { usage: over.usage ?? { prompt_tokens: 100, completion_tokens: 50 } }),
      };
    },
    ...over,
  };
  return { m, seen };
}

const ask = (text = "hello", max_tokens?: number): ChatBody => ({
  model: "stub",
  messages: [{ role: "user", content: text }],
  ...(max_tokens ? { max_tokens } : {}),
});

describe("within budget", () => {
  test("calls go through and usage is summed outside the executor", async () => {
    const { m } = model();
    const b = new BudgetBroker(budget(), m);
    expect((await b.complete(ask())).ok).toBe(true);
    expect((await b.complete(ask())).ok).toBe(true);
    expect(b.usage()).toEqual({ inputTokens: 200, outputTokens: 100, toolCalls: 0, usd: 0, calls: 2 });
    expect(b.exhausted()).toBeNull();
  });

  test("max_tokens is clamped to the output tokens left", async () => {
    const { m, seen } = model();
    const b = new BudgetBroker(budget({ maxOutputTokens: 120 }), m);
    await b.complete(ask("a", 4_000));
    await b.complete(ask("b"));
    expect(seen[0]!.max_tokens).toBe(120);
    expect(seen[1]!.max_tokens).toBe(70);
  });
});

describe("limits stop the task", () => {
  test("crossing the input limit exhausts the budget; the next call never reaches the model", async () => {
    const { m, seen } = model({ usage: { prompt_tokens: 600, completion_tokens: 10 } });
    const b = new BudgetBroker(budget({ maxInputTokens: 1_000 }), m);
    await b.complete(ask());
    await b.complete(ask());
    expect(b.exhausted()).toContain("input tokens");
    const third = await b.complete(ask());
    expect(third.ok).toBe(false);
    expect(seen).toHaveLength(2);
  });

  test("a request whose own text is already over the input left is refused before the call", async () => {
    const { m, seen } = model();
    const b = new BudgetBroker(budget({ maxInputTokens: 100 }), m);
    const r = await b.complete(ask("x".repeat(2_000)));
    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("tool calls the model asks for count, past the limit the budget is exhausted", async () => {
    const { m } = model({ toolCalls: 2 });
    const b = new BudgetBroker(budget({ maxToolCalls: 3 }), m);
    await b.complete(ask());
    expect(b.exhausted()).toBeNull();
    await b.complete(ask());
    expect(b.usage().toolCalls).toBe(4);
    expect(b.exhausted()).toContain("tool calls");
  });

  test("dollars are charged from usage and price; crossing the cap exhausts", async () => {
    // 100 in at $1/M + 50 out at $2/M = $0.0002 per call.
    const { m } = model({ usdPerMInput: 1, usdPerMOutput: 2 });
    const b = new BudgetBroker(budget({ maxUsd: 0.0003, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 }), m);
    await b.complete(ask());
    expect(b.usage().usd).toBeCloseTo(0.0002);
    expect(b.exhausted()).toBeNull();
    await b.complete(ask());
    expect(b.exhausted()).toContain("USD");
  });
});

describe("found by the S1.3b review", () => {
  test("parallel calls are served one at a time, so none slips past a limit another already used", async () => {
    const seen: ChatBody[] = [];
    const slow: BrokerModel = {
      id: "stub",
      usdPerMInput: 0,
      usdPerMOutput: 0,
      async call(body) {
        seen.push(body);
        await Bun.sleep(20);
        return { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 600, completion_tokens: 10 } };
      },
    };
    const b = new BudgetBroker(budget({ maxInputTokens: 1_000 }), slow);
    const results = await Promise.all([b.complete(ask()), b.complete(ask()), b.complete(ask())]);
    expect(seen).toHaveLength(2);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
  });

  test("the executor cannot pick another model or ask for several answers", async () => {
    const { m, seen } = model();
    const b = new BudgetBroker(budget(), m);
    await b.complete({ ...ask(), model: "some-expensive-model", n: 8 });
    expect(seen[0]!.model).toBe("stub");
    expect(seen[0]!.n).toBe(1);
  });

  test("tool calls written as <tool_call> text count like native ones", async () => {
    const text: BrokerModel = {
      id: "stub",
      usdPerMInput: 0,
      usdPerMOutput: 0,
      call: async () => ({
        choices: [{ message: { content: 'a <tool_call>{"name":"x","args":{}}</tool_call> b <tool_call>{"name":"y","args":{}}</tool_call>' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
    const b = new BudgetBroker(budget(), text);
    await b.complete(ask());
    expect(b.usage().toolCalls).toBe(2);
  });
});

describe("money safety", () => {
  test("a USD limit of 0 allows only a free model: a priced one is refused before any call", async () => {
    const { m, seen } = model({ usdPerMInput: 0.2, usdPerMOutput: 0.8 });
    const b = new BudgetBroker(budget({ maxUsd: 0 }), m);
    const r = await b.complete(ask());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("USD limit is 0");
    expect(seen).toHaveLength(0);
  });

  test("a model that reports no usage is charged an estimate, never zero", async () => {
    const { m } = model({ usage: null });
    const b = new BudgetBroker(budget(), m);
    await b.complete(ask("x".repeat(400)));
    expect(b.usage().inputTokens).toBeGreaterThan(0);
    expect(b.usage().outputTokens).toBeGreaterThan(0);
  });

  test("a model that reports nonsense usage is charged the estimate instead", async () => {
    const { m } = model({ usage: { prompt_tokens: -5, completion_tokens: Number.NaN } });
    const b = new BudgetBroker(budget(), m);
    await b.complete(ask("x".repeat(400)));
    expect(b.usage().inputTokens).toBeGreaterThan(0);
    expect(Number.isFinite(b.usage().outputTokens)).toBe(true);
  });

  test("a model call that throws is spent nothing extra and reported, the task is not exhausted", async () => {
    const { m } = model({ call: async () => { throw new Error("upstream 502"); } });
    const b = new BudgetBroker(budget(), m);
    const r = await b.complete(ask());
    expect(r).toEqual({ ok: false, reason: "model call failed: upstream 502" });
    expect(b.exhausted()).toBeNull();
  });
});

describe("found by the second S1.3 review (#9)", () => {
  test("max_completion_tokens is clamped too, and only max_tokens reaches the model", async () => {
    const { m, seen } = model();
    const b = new BudgetBroker(budget({ maxOutputTokens: 40 }), m);
    await b.complete({ ...ask(), max_completion_tokens: 10_000 });
    expect(seen[0]!.max_tokens).toBe(40);
    expect(seen[0]!.max_completion_tokens).toBeUndefined();
  });

  test("the input estimate counts the whole request, tool definitions included", async () => {
    const { m, seen } = model();
    const b = new BudgetBroker(budget({ maxInputTokens: 100 }), m);
    const tools = [{ type: "function", function: { name: "x", description: "y".repeat(600) } }];
    const got = await b.complete({ ...ask("hi"), tools });
    expect(got.ok).toBe(false);
    expect(seen.length).toBe(0);
  });

  test("usage reported as 0 is treated as missing and charged the estimate", async () => {
    const { m } = model({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    const b = new BudgetBroker(budget(), m);
    await b.complete(ask("x".repeat(90)));
    expect(b.usage().inputTokens).toBeGreaterThan(0);
    expect(b.usage().outputTokens).toBeGreaterThan(0);
  });

  test("<tool_call> text inside array content parts counts", async () => {
    const m: BrokerModel = {
      id: "stub",
      usdPerMInput: 0,
      usdPerMOutput: 0,
      async call() {
        return {
          choices: [{ message: { content: [{ type: "text", text: "<tool_call>a</tool_call><tool_call>b</tool_call>" }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        };
      },
    };
    const b = new BudgetBroker(budget(), m);
    await b.complete(ask());
    expect(b.usage().toolCalls).toBe(2);
  });

  test("a request without messages is refused before the model", async () => {
    const { m, seen } = model();
    const b = new BudgetBroker(budget(), m);
    const got = await b.complete({ model: "stub" } as unknown as ChatBody);
    expect(got.ok).toBe(false);
    expect(seen.length).toBe(0);
  });
});
