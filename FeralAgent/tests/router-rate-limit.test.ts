/**
 * The rate-limit gate as the router actually uses it.
 *
 * The scenario this exists for: a NIM free-tier key (40 RPM) and a task that
 * fans out into tool calls. Each agent-loop iteration is another completion, so
 * a genuinely multi-step task used to walk into the cap and every subsequent
 * request came back 429 — the agent fell over mid-task.
 */

import { describe, expect, test } from "bun:test";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import type { InferenceRequest } from "../src/types.ts";

const NIM_URL = "https://integrate.api.nvidia.com/v1";
const BUDGET = { perConversation: 5_000_000, perDay: 50_000_000, onExhausted: "stop" } as const;

function nimRouter(db: ReturnType<typeof openDatabase>) {
  const audit = new AuditLog(db.raw);
  return new InferenceRouter(
    {
      primary: { provider: "nvidia", model: "m", baseUrl: NIM_URL, apiKey: "k" },
      tokenBudget: BUDGET,
    },
    audit.logger,
    db.raw,
  );
}

const req = (sessionId = "s1"): InferenceRequest => ({
  sessionId,
  messages: [{ role: "user", content: "hi" }],
});

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const completion = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
};

describe("InferenceRouter rate limiting", () => {
  test("a 429 is retried after Retry-After instead of failing the task", async () => {
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        // First attempt is rejected; the provider says to come back in 1s.
        if (calls === 1) {
          return new Response("rate limit exceeded", {
            status: 429,
            headers: { "retry-after": "1" },
          });
        }
        return okResponse(completion);
      }) as typeof fetch;

      const router = nimRouter(db);
      const waits: number[] = [];
      router.setThrottleListener((info) => waits.push(info.waitMs));

      const started = Date.now();
      const res = await router.complete(req());

      // The task survives the 429 rather than dying on it.
      expect(res.content).toBe("ok");
      expect(calls).toBe(2);

      // It honoured Retry-After (1s), and said so rather than going quiet.
      expect(waits).toEqual([1000]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);

      // Both the rejected attempt and the retry count against the window —
      // the provider charged us for both.
      expect(router.rateLimitCount(NIM_URL)).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  }, 10_000);

  test("a non-429 failure is not retried", async () => {
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response("bad request", { status: 400 });
      }) as typeof fetch;

      const router = nimRouter(db);
      // A 400 is a bug in our request, not congestion. Retrying it just burns
      // rate-limit budget to get the same answer.
      await expect(router.complete(req())).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  test("a 502 is retried — a provider having a bad second must not end a night's work", async () => {
    // The gap this closes: only a 429 was ever retried, so any other transient
    // failure threw, the turn came back as `no_answer`, and `no_answer` is not
    // continuable. One gateway blip at hour three ended the whole unattended
    // run and delivered the error text as the answer.
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return calls === 1 ? new Response("bad gateway", { status: 502 }) : okResponse(completion);
      }) as typeof fetch;

      const router = nimRouter(db);
      const res = await router.complete(req());
      expect(res.content).toBe("ok");
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  }, 10_000);

  test("a dropped connection is retried", async () => {
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return okResponse(completion);
      }) as typeof fetch;

      const router = nimRouter(db);
      expect((await router.complete(req())).content).toBe("ok");
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  }, 10_000);

  test("a provider that is down surfaces instead of retrying forever", async () => {
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response("down", { status: 503 });
      }) as typeof fetch;

      await expect(nimRouter(db).complete(req())).rejects.toThrow();
      // Bounded: the attempt plus MAX_TRANSIENT_RETRIES, not an infinite loop.
      expect(calls).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  }, 20_000);

  test("a user stop during a retry wait is not overridden", async () => {
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      const ac = new AbortController();
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        ac.abort();
        return new Response("bad gateway", { status: 502 });
      }) as typeof fetch;

      await expect(
        nimRouter(db).complete({ ...req(), signal: ac.signal }),
      ).rejects.toThrow();
      // Stopped means stopped — no second attempt on the user's behalf.
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  }, 10_000);

  test("an unreasonable Retry-After surfaces instead of freezing the agent", async () => {
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response("quota exhausted", {
          status: 429,
          // Ten minutes. Blocking that long is worse than failing: the user is
          // left staring at an agent that looks hung.
          headers: { "retry-after": "600" },
        });
      }) as typeof fetch;

      const router = nimRouter(db);
      await expect(router.complete(req())).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  test("a local endpoint is never throttled", async () => {
    const originalFetch = globalThis.fetch;
    const db = openDatabase(":memory:");
    try {
      globalThis.fetch = (async () => okResponse(completion)) as typeof fetch;

      const audit = new AuditLog(db.raw);
      const router = new InferenceRouter(
        {
          primary: { provider: "openai", model: "m", baseUrl: "http://127.0.0.1:11435" },
          tokenBudget: BUDGET,
        },
        audit.logger,
        db.raw,
      );
      const waits: number[] = [];
      router.setThrottleListener((info) => waits.push(info.waitMs));

      // Well past NIM's cap. The bundled engine has no rate limit, and
      // throttling it would be pure self-harm.
      for (let i = 0; i < 50; i++) await router.complete(req());

      expect(waits).toEqual([]);
      expect(router.rateLimitCount("http://127.0.0.1:11435")).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  }, 15_000);
});
