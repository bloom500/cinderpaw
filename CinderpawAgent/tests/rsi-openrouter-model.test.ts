/**
 * The OpenRouter model behind the budget broker. No network: `fetch` is
 * faked, so these tests cost nothing.
 */
import { describe, expect, test } from "bun:test";
import { MUSE_SPARK_CONTRIBUTOR, openRouterModel } from "../src/rsi/research/openrouter-model.ts";
import { BudgetBroker } from "../src/rsi/research/task-budget.ts";

function fakeFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

const answer = { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } };

describe("openRouterModel", () => {
  test("posts the body unstreamed with the key, and the broker charges Muse Spark's price", async () => {
    const { f, seen } = fakeFetch(200, answer);
    const m = openRouterModel(MUSE_SPARK_CONTRIBUTOR, "sk-test", f);
    const b = new BudgetBroker({ maxInputTokens: 5_000_000, maxOutputTokens: 5_000_000, maxToolCalls: 5, maxWallMs: 1, maxUsd: 1 }, m);
    const got = await b.complete({ model: "anything", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(got.ok).toBe(true);
    const sent = JSON.parse(String(seen[0]!.init.body));
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(sent.stream).toBe(false);
    expect(sent.model).toBe("meta/muse-spark-1.3-contributor");
    expect(b.usage().usd).toBeCloseTo(0.3);
  });

  test("an HTTP error and a 200 carrying an error both throw, so the broker charges nothing", async () => {
    for (const [status, body] of [[402, { error: { message: "no credit" } }], [200, { error: { message: "provider down" } }]] as const) {
      const m = openRouterModel(MUSE_SPARK_CONTRIBUTOR, "k", fakeFetch(status, body).f);
      await expect(m.call({ model: "x", messages: [] })).rejects.toThrow(/no credit|provider down/);
    }
  });

  test("no key: refused at construction, with where the key comes from", () => {
    expect(() => openRouterModel(MUSE_SPARK_CONTRIBUTOR, "")).toThrow("keychain");
  });
});
