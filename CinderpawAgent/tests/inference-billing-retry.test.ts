import { afterEach, describe, expect, test } from "bun:test";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import type { InferenceRequest } from "../src/types.ts";

const OPENAI_URL = "https://api.openai.com";
const LOCAL_URL = "http://127.0.0.1:11435";
const originalFetch = globalThis.fetch;
let db: ReturnType<typeof openDatabase> | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  db?.close();
  db = undefined;
});

function setup(fallback = false) {
  db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const router = new InferenceRouter({
    primary: { provider: "openai_compatible", model: "m", baseUrl: OPENAI_URL, apiKey: "test-key" },
    fallback: fallback ? { provider: "openai", model: "local", baseUrl: LOCAL_URL } : undefined,
    tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" },
  }, audit.logger, db.raw);
  const waits: number[] = [];
  router.setThrottleListener((info) => waits.push(info.waitMs));
  return { router, waits, audit };
}

function request(stream: boolean): InferenceRequest {
  return {
    sessionId: "billing-retry",
    messages: [{ role: "user", content: "hi" }],
    onToken: stream ? () => {} : undefined,
  };
}

const completion = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
};

const billingErrors = [
  ["exhausted credits", {
    message: "Your organization has no prepaid credits remaining.",
    type: "insufficient_quota", code: "credit_balance_exhausted",
  }],
  ["organization spend limit, even after a long message", {
    message: "Account limit. ".repeat(30),
    type: "rate_limit_error", code: "organization_spend_limit_exceeded",
  }],
  ["project spend limit", { type: "rate_limit_error", code: "project_spend_limit_exceeded" }],
  ["organization usage limit", { type: "rate_limit_error", code: "organization_usage_limit_exceeded" }],
  ["legacy quota type", { type: "insufficient_quota", code: null }],
  ["legacy quota code", { code: "insufficient_quota" }],
] as const;

describe("permanent provider quota failures", () => {
  for (const stream of [false, true]) {
    for (const [label, error] of billingErrors) {
      test(`${stream ? "streaming" : "non-streaming"}: ${label} stops after one attempt`, async () => {
        const { router, waits, audit } = setup();
        let calls = 0;
        globalThis.fetch = (async () => {
          calls++;
          // A misleading Retry-After must not make billing failures retryable.
          return Response.json({ error }, { status: 429, headers: { "retry-after": "0" } });
        }) as typeof fetch;

        await expect(router.complete(request(stream))).rejects.toThrow("returned 429");
        expect(calls).toBe(1);
        expect(waits).toEqual([]);
        expect(db!.raw.query("SELECT result FROM audit_log WHERE action_type = 'inference'").all())
          .toEqual([{ result: "error" }]);
        expect(audit.verify()).toEqual({ ok: true, entries: 1, dropped: 0 });
      });
    }
  }

  test("tries the configured local fallback immediately when primary credits are exhausted", async () => {
    const { router, waits } = setup(true);
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith(OPENAI_URL)) {
        return Response.json({ error: billingErrors[0][1] }, {
          status: 429, headers: { "retry-after": "0" },
        });
      }
      return Response.json(completion);
    }) as typeof fetch;

    const result = await router.complete(request(false));
    expect(result.content).toBe("ok");
    expect(result.usedFallback).toBe(true);
    expect(urls).toEqual([`${OPENAI_URL}/v1/chat/completions`, `${LOCAL_URL}/v1/chat/completions`]);
    expect(waits).toEqual([]);
  });
});

describe("temporary 429 failures", () => {
  const responses = [
    ["structured rate limit", JSON.stringify({ error: { type: "rate_limit_error", code: "slow_down" } })],
    ["quota words in a transient message", JSON.stringify({ error: {
      type: "rate_limit_error", code: "rate_limit_exceeded", message: "Token quota reached; slow down.",
    } })],
    ["plain text", "rate limit exceeded"],
    ["malformed JSON", '{"error":'],
    ["non-object error", JSON.stringify({ error: "rate limited" })],
  ] as const;

  for (const [label, body] of responses) {
    test(`${label} is retried and can succeed`, async () => {
      const { router, waits } = setup();
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return calls === 1
          ? new Response(body, { status: 429, headers: { "retry-after": "0" } })
          : Response.json(completion);
      }) as typeof fetch;

      const result = await router.complete(request(false));
      expect(result.content).toBe("ok");
      expect(result.retries).toBe(1);
      expect(calls).toBe(2);
      expect(waits).toEqual([0]);
    });
  }
});
