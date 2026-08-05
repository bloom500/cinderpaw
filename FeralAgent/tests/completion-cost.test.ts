/**
 * Where the tokens go — the measurement, before any optimisation.
 *
 * The rule this file exists to enforce: nothing about cost is deduced. Every
 * number is the provider's own, recorded at the one seam every completion
 * passes through, and the two things that would quietly corrupt the record are
 * asserted directly:
 *
 *   1. The two provider dialects disagree about whether `prompt_tokens`
 *      INCLUDES the cached tokens. OpenAI says yes, Anthropic says no. A single
 *      `fresh = prompt − cached` would therefore be right on one and wrong on
 *      the other, with nothing to indicate which — and a cost table built on it
 *      would rank the wrong category first, confidently.
 *
 *   2. A provider that reports nothing about caching must record NULL, never 0.
 *      Zero is a finding ("nothing was cached"); NULL is a different one ("we do
 *      not know"). Collapsed, a cache that silently stopped working is
 *      indistinguishable from one that is working and empty.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import type { InferenceConfig } from "../src/types.ts";

const BUDGET = { perConversation: 500_000, perDay: 5_000_000, onExhausted: "stop" } as const;

function installFetchMock(body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

interface CostRow {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  fresh_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  latency_ms: number;
  used_fallback: number;
}

/**
 * Drive one completion against a mocked provider and hand back the row it
 * wrote. `provider` picks which dialect the router will parse the body as.
 */
async function completeOnce(body: unknown, provider: "openai" | "anthropic" | "ollama") {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const mock = installFetchMock(body);
  restoreFetch = mock.restore;

  const config: InferenceConfig = {
    primary: { provider, model: "m", baseUrl: "https://api.example.com", apiKey: "k" },
    trustedBaseUrls: ["https://api.example.com"],
    tokenBudget: BUDGET,
  };
  const router = new InferenceRouter(config, audit.logger, db.raw);
  const res = await router.complete({
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
  });
  const rows = db.raw
    .query<CostRow, []>("SELECT * FROM completion_cost")
    .all();
  return { res, rows, close: () => db.close() };
}

describe("the dialects are normalized where they are spoken", () => {
  test("OpenAI: prompt_tokens INCLUDES the cached ones, so fresh is the difference", async () => {
    const { res, rows, close } = await completeOnce(
      {
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      },
      "openai",
    );

    expect(res.cacheReadTokens).toBe(800);
    // 1000 total, 800 of them cached ⇒ 200 paid for in full.
    expect(res.freshPromptTokens).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompt_tokens).toBe(1000);
    expect(rows[0]!.fresh_tokens).toBe(200);
    expect(rows[0]!.cache_read_tokens).toBe(800);
    close();
  });

  test("Anthropic: input_tokens EXCLUDES the cached ones, so fresh IS input_tokens", async () => {
    const { res, rows, close } = await completeOnce(
      {
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 120,
        },
      },
      "anthropic",
    );

    expect(res.cacheReadTokens).toBe(800);
    expect(res.cacheWriteTokens).toBe(120);
    // The same real prompt as the OpenAI case above: 200 fresh, 800 from cache.
    // Subtracting here would have produced -600, and a table full of them.
    expect(res.freshPromptTokens).toBe(200);
    expect(rows[0]!.fresh_tokens).toBe(200);
    expect(rows[0]!.cache_read_tokens).toBe(800);
    expect(rows[0]!.cache_write_tokens).toBe(120);
    close();
  });

  test("the same real prompt produces the same fresh count on both dialects", async () => {
    const openai = await completeOnce(
      {
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      },
      "openai",
    );
    const anthropic = await completeOnce(
      {
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 800 },
      },
      "anthropic",
    );
    // This is the whole point of normalizing at the adapter: one number that
    // means the same thing regardless of who reported it.
    expect(anthropic.res.freshPromptTokens).toBe(openai.res.freshPromptTokens!);
    openai.close();
    anthropic.close();
  });
});

describe("unknown is not zero", () => {
  test("a provider that says nothing about caching records NULL, not 0", async () => {
    const { res, rows, close } = await completeOnce(
      { message: { content: "hi" }, prompt_eval_count: 11, eval_count: 7 },
      "ollama",
    );

    expect(res.cacheReadTokens).toBeUndefined();
    expect(res.freshPromptTokens).toBeUndefined();
    expect(rows[0]!.cache_read_tokens).toBeNull();
    expect(rows[0]!.cache_write_tokens).toBeNull();
    expect(rows[0]!.fresh_tokens).toBeNull();
    // The tokens themselves are still recorded — silence about cache is not
    // silence about cost.
    expect(rows[0]!.prompt_tokens).toBe(11);
    expect(rows[0]!.completion_tokens).toBe(7);
    close();
  });

  test("a cache that reports a genuine zero is NOT the same row as silence", async () => {
    const { rows, close } = await completeOnce(
      {
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
      "openai",
    );
    // Nothing was cached — a finding, and a different one from "we don't know".
    expect(rows[0]!.cache_read_tokens).toBe(0);
    expect(rows[0]!.fresh_tokens).toBe(1000);
    close();
  });
});

describe("one row per completion, at the seam every completion passes", () => {
  test("the row carries what it cost and how long it took", async () => {
    const { rows, close } = await completeOnce(
      { message: { content: "hi" }, prompt_eval_count: 11, eval_count: 7 },
      "ollama",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("m");
    expect(rows[0]!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.used_fallback).toBe(0);
    close();
  });
});
