/**
 * Inference router — runtime defense-in-depth.
 *
 * These tests drive `complete()` end-to-end with a mocked global fetch, so they
 * prove the trusted-endpoint enforcement at *call time* (not just construction)
 * and that port normalization is symmetric. The mutation tests reach the router
 * through its retained config reference — the same path a real bug or rogue
 * caller would take — and confirm the call is refused before any fetch and that
 * a `blocked` audit row is written.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import {
  InferenceRouter,
  InferenceError,
  normalizeBaseUrl,
} from "../src/sandbox/inference-router.ts";
import type { InferenceConfig } from "../src/types.ts";

const BUDGET = {
  perConversation: 50_000,
  perDay: 500_000,
  onExhausted: "stop",
} as const;

/** Replace global fetch with a recording stub; returns a restore function. */
function installFetchMock(
  body: unknown,
): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

/** Fetch stub that fails the test if it is ever invoked. */
function installFetchTrap(): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    throw new Error("fetch should not have been called");
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

/** Standard Ollama success envelope: 11 prompt + 7 completion = 18 tokens. */
const OLLAMA_OK = {
  message: { content: "hi" },
  prompt_eval_count: 11,
  eval_count: 7,
};

function auditRows(db: Database, result: string) {
  return db
    .query<
      { action_type: string; result: string; blocked_reason: string | null; token_cost: number | null },
      [string]
    >(
      "SELECT action_type, result, blocked_reason, token_cost FROM audit_log WHERE result = ?",
    )
    .all(result);
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("normalizeBaseUrl (Issue 1: port normalization)", () => {
  test("explicit default port equals implicit form", () => {
    expect(normalizeBaseUrl("https://ollama.com:443")).toBe(
      normalizeBaseUrl("https://ollama.com"),
    );
    expect(normalizeBaseUrl("http://ollama.com:80")).toBe(
      normalizeBaseUrl("http://ollama.com"),
    );
  });

  test("non-default port is preserved and distinguishes targets", () => {
    expect(normalizeBaseUrl("https://ollama.com:11434")).not.toBe(
      normalizeBaseUrl("https://ollama.com"),
    );
    expect(normalizeBaseUrl("https://ollama.com:443")).not.toBe(
      normalizeBaseUrl("https://ollama.com:11434"),
    );
  });

  test("trailing slash and case are ignored", () => {
    expect(normalizeBaseUrl("HTTPS://Ollama.com:443/")).toBe(
      normalizeBaseUrl("https://ollama.com"),
    );
  });
});

describe("port normalization roundtrip at runtime (Issue 1)", () => {
  test("allowlist https://ollama.com accepts request to :443", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const mock = installFetchMock(OLLAMA_OK);
    restoreFetch = mock.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "https://ollama.com:443" },
      trustedBaseUrls: ["https://ollama.com"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    const res = await router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.content).toBe("hi");
    expect(res.totalTokens).toBe(18);
    expect(mock.calls[0]).toBe("https://ollama.com:443/api/chat");
    expect(auditRows(db.raw, "success")).toHaveLength(1);
    db.close();
  });
});

describe("port mismatch detection at runtime (Issue 1 / defense-in-depth)", () => {
  test("request to a different port than the allowlist is blocked + audited", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const trap = installFetchTrap();
    restoreFetch = trap.restore;

    // Constructed with the trusted port; passes construction.
    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "https://ollama.com:443" },
      trustedBaseUrls: ["https://ollama.com:443"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    // Now the live target drifts to a non-allowed port.
    config.primary.baseUrl = "https://ollama.com:11434";

    await expect(
      router.complete({ sessionId: "s1", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(InferenceError);

    expect(trap.calls).toHaveLength(0); // never reached the network
    const blocked = auditRows(db.raw, "blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.some((r) => r.blocked_reason?.includes("11434"))).toBe(true);
    expect(
      blocked.some((r) => r.blocked_reason?.includes("not in trustedBaseUrls")),
    ).toBe(true);
    db.close();
  });
});

describe("target mutation bypass attempt (defense-in-depth)", () => {
  test("mutating baseUrl to a foreign host is refused before fetch", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const trap = installFetchTrap();
    restoreFetch = trap.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      tokenBudget: BUDGET, // default allowlist = configured target
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    // Post-construction tampering with the retained config reference.
    config.primary.baseUrl = "http://evil.example:9999";

    await expect(
      router.complete({ sessionId: "s1", messages: [{ role: "user", content: "leak" }] }),
    ).rejects.toBeInstanceOf(InferenceError);

    expect(trap.calls).toHaveLength(0);
    const blocked = auditRows(db.raw, "blocked");
    expect(
      blocked.some(
        (r) =>
          r.blocked_reason?.includes("not in trustedBaseUrls") &&
          r.blocked_reason?.includes("evil.example"),
      ),
    ).toBe(true);
    db.close();
  });
});

describe("end-to-end audit verification (happy path)", () => {
  test("successful inference writes one success row with matching tokenCost", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const mock = installFetchMock(OLLAMA_OK);
    restoreFetch = mock.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    const res = await router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });

    const success = auditRows(db.raw, "success");
    expect(success).toHaveLength(1);
    expect(success[0]!.action_type).toBe("inference");
    expect(success[0]!.token_cost).toBe(res.totalTokens);
    expect(success[0]!.token_cost).toBe(18);
    db.close();
  });
});

describe("conversation budget gate", () => {
  /** Budget so small a single OLLAMA_OK (18 tokens) blows it on the next call. */
  const TINY_BUDGET = {
    perConversation: 10,
    perDay: 500_000,
    onExhausted: "stop",
  } as const;

  test("a request over the per-conversation budget is blocked", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const mock = installFetchMock(OLLAMA_OK);
    restoreFetch = mock.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      tokenBudget: TINY_BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    // First call succeeds and records 18 tokens, pushing the session over 10.
    await router.complete({ sessionId: "s1", messages: [{ role: "user", content: "hi" }] });
    expect(router.conversationTokens("s1")).toBe(18);

    // Second call is gated before reaching the network.
    await expect(
      router.complete({ sessionId: "s1", messages: [{ role: "user", content: "again" }] }),
    ).rejects.toMatchObject({ name: "BudgetExhaustedError", reason: "conversation" });
    db.close();
  });

  test("skipBudgetCheck lets an over-budget call through (summarizer recovery)", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const mock = installFetchMock(OLLAMA_OK);
    restoreFetch = mock.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      tokenBudget: TINY_BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    // Burn the budget.
    await router.complete({ sessionId: "s1", messages: [{ role: "user", content: "hi" }] });
    expect(router.conversationTokens("s1")).toBeGreaterThan(TINY_BUDGET.perConversation);

    // A bypassing call (the summarizer) still runs even though we're over budget…
    const res = await router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "summarize" }],
      skipBudgetCheck: true,
    });
    expect(res.content).toBe("hi");
    // …and its usage is still accounted for (gate bypassed, accounting kept).
    expect(router.conversationTokens("s1")).toBe(36);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — `completeWith(primary, fallback, req)` seam.
//
// Brain Stack (slice 5) calls this directly with the targets it routed
// to. The router keeps ONE code path for the actual fetch / budget /
// audit / abort machinery; `complete()` is a thin wrapper that hands the
// configured primary + fallback to `completeWith`.
//
// These tests assert:
//   - `completeWith` actually USES the passed targets (not #primary /
//     #fallback) — verified by URL inspection of the mocked fetch
//   - the same trustedBaseUrls enforcement runs at call time (the brief
//     is explicit about this; an untrusted passed target must throw)
//   - the fallback path works the same way as `complete()`'s fallback
//     path (same audit row, same error shape)
//   - `complete()` is unchanged in behaviour after the refactor
//     (regression — the existing tests above already prove this; this
//     file adds one extra sanity check that the wrapper delegates)
// ---------------------------------------------------------------------------

/** Mock that drives fetch by URL: each URL gets its own behavior. */
function installFetchRouter(
  behaviors: Record<string, { ok: true; body: unknown } | { ok: false; message: string }>,
): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);
    const b = behaviors[url];
    if (!b) {
      throw new Error(`fetch not configured for URL: ${url}`);
    }
    if (!b.ok) throw new Error(b.message);
    return new Response(JSON.stringify(b.body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

describe("InferenceRouter.completeWith() — passed targets are honoured (slice 4)", () => {
  test("completeWith routes to the PASSED primary, not #primary", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const mock = installFetchMock(OLLAMA_OK);
    restoreFetch = mock.restore;

    // Router configured with primary = localhost:11434 …
    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "configured-model", baseUrl: "http://localhost:11434" },
      trustedBaseUrls: ["http://localhost:11434", "http://localhost:11435"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    // … but completeWith is called with primary = localhost:11435.
    const passedPrimary = {
      provider: "ollama",
      model: "passed-model",
      baseUrl: "http://localhost:11435",
    };
    const res = await router.completeWith(passedPrimary, undefined, {
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.content).toBe("hi");
    expect(mock.calls).toHaveLength(1);
    // The passed baseUrl wins: fetch hits :11435, not the configured :11434.
    expect(mock.calls[0]).toBe("http://localhost:11435/api/chat");
    db.close();
  });

  test("completeWith uses the PASSED fallback when primary fails", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    // Passed primary fails; passed fallback succeeds.
    const mock = installFetchRouter({
      "http://localhost:11434/api/chat": { ok: false, message: "primary down" },
      "http://localhost:11435/api/chat": { ok: true, body: OLLAMA_OK },
    });
    restoreFetch = mock.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "configured-primary", baseUrl: "http://localhost:9999" },
      trustedBaseUrls: ["http://localhost:11434", "http://localhost:11435", "http://localhost:9999"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    // completeWith is called with DIFFERENT primary+fallback than #primary.
    // Both are configured-trusted; primary fails, fallback succeeds.
    const res = await router.completeWith(
      { provider: "ollama", model: "passed-primary", baseUrl: "http://localhost:11434" },
      { provider: "ollama", model: "passed-fallback", baseUrl: "http://localhost:11435" },
      { sessionId: "s1", messages: [{ role: "user", content: "hi" }] },
    );

    expect(res.usedFallback).toBe(true);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]).toBe("http://localhost:11434/api/chat");
    expect(mock.calls[1]).toBe("http://localhost:11435/api/chat");
    db.close();
  });

  test("completeWith with no fallback: primary failure throws InferenceError", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const mock = installFetchRouter({
      "http://localhost:11434/api/chat": { ok: false, message: "primary down" },
    });
    restoreFetch = mock.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      trustedBaseUrls: ["http://localhost:11434"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    await expect(
      router.completeWith(
        { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
        undefined,
        { sessionId: "s1", messages: [{ role: "user", content: "hi" }] },
      ),
    ).rejects.toBeInstanceOf(InferenceError);

    const failure = auditRows(db.raw, "error");
    expect(failure.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe("InferenceRouter.completeWith() — trustedBaseUrls enforcement (slice 4)", () => {
  test("completeWith refuses a primary whose URL is NOT in trustedBaseUrls", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const trap = installFetchTrap();
    restoreFetch = trap.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "https://allowed.com/v1" },
      trustedBaseUrls: ["https://allowed.com/v1"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    await expect(
      router.completeWith(
        { provider: "ollama", model: "evil", baseUrl: "https://evil.example/v1" },
        undefined,
        { sessionId: "s1", messages: [{ role: "user", content: "hi" }] },
      ),
    ).rejects.toBeInstanceOf(InferenceError);

    // Never reached the network.
    expect(trap.calls).toHaveLength(0);

    // `blocked` audit row written with the offending URL in the reason.
    const blocked = auditRows(db.raw, "blocked");
    expect(
      blocked.some(
        (r) =>
          r.blocked_reason?.includes("evil.example") &&
          r.blocked_reason?.includes("not in trustedBaseUrls"),
      ),
    ).toBe(true);
    db.close();
  });

  test("completeWith refuses a FALLBACK whose URL is not in trustedBaseUrls", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const trap = installFetchTrap();
    restoreFetch = trap.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "https://allowed.com/v1" },
      trustedBaseUrls: ["https://allowed.com/v1"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    await expect(
      router.completeWith(
        { provider: "ollama", model: "m", baseUrl: "https://allowed.com/v1" },
        { provider: "ollama", model: "evil-fb", baseUrl: "https://evil.example/v1" },
        { sessionId: "s1", messages: [{ role: "user", content: "hi" }] },
      ),
    ).rejects.toBeInstanceOf(InferenceError);

    expect(trap.calls).toHaveLength(0);
    const blocked = auditRows(db.raw, "blocked");
    expect(blocked.some((r) => r.blocked_reason?.includes("evil.example"))).toBe(true);
    db.close();
  });

  test("completeWith refuses BEFORE budget / abort plumbing runs", async () => {
    // Budget so small that any normal call would trip it. If completeWith
    // runs the budget check before the trusted-URL check, this throws
    // BudgetExhaustedError instead of InferenceError. The order matters.
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const trap = installFetchTrap();
    restoreFetch = trap.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "https://allowed.com/v1" },
      trustedBaseUrls: ["https://allowed.com/v1"],
      tokenBudget: { perConversation: 1, perDay: 500_000, onExhausted: "stop" },
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    await expect(
      router.completeWith(
        { provider: "ollama", model: "evil", baseUrl: "https://evil.example/v1" },
        undefined,
        { sessionId: "s1", messages: [{ role: "user", content: "hi" }] },
      ),
    ).rejects.toBeInstanceOf(InferenceError);
    // NOT a BudgetExhaustedError — the trusted-URL check fires first.
    db.close();
  });
});

describe("InferenceRouter.complete() — regression after the S4 refactor", () => {
  test("complete() delegates to completeWith() — same behaviour as before", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const mock = installFetchMock(OLLAMA_OK);
    restoreFetch = mock.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      trustedBaseUrls: ["http://localhost:11434"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    const res = await router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });

    // Same success shape, same audit row, same URL — pre-S4 behaviour.
    expect(res.content).toBe("hi");
    expect(res.totalTokens).toBe(18);
    expect(mock.calls).toEqual(["http://localhost:11434/api/chat"]);
    expect(auditRows(db.raw, "success")).toHaveLength(1);
    db.close();
  });

  test("complete() falls back to #fallback when #primary fails", async () => {
    // Sanity check that the fallback path still works through complete()
    // after the refactor (the existing tests cover this but explicit
    // here because S4 changed the call graph).
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const mock = installFetchRouter({
      "http://localhost:11434/api/chat": { ok: false, message: "primary down" },
      "http://localhost:11435/api/chat": { ok: true, body: OLLAMA_OK },
    });
    restoreFetch = mock.restore;

    const config: InferenceConfig = {
      primary: { provider: "ollama", model: "primary", baseUrl: "http://localhost:11434" },
      fallback: { provider: "ollama", model: "fallback", baseUrl: "http://localhost:11435" },
      trustedBaseUrls: ["http://localhost:11434", "http://localhost:11435"],
      tokenBudget: BUDGET,
    };
    const router = new InferenceRouter(config, audit.logger, db.raw);

    const res = await router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.usedFallback).toBe(true);
    expect(mock.calls).toHaveLength(2);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Slice 5 — `cloudReachable` getter.
//
// Brain Stack uses this to compute the `offline` hint passed to
// `brain.route()`: offline = primary is local AND cloud is not reachable.
// When fallback is configured and on a non-loopback host, cloud is
// reachable even if primary is local — Brain Stack won't force-route to
// local-only models in that case.
// ---------------------------------------------------------------------------

describe("InferenceRouter.cloudReachable (slice 5)", () => {
  test("local primary, no fallback → cloud NOT reachable", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
        trustedBaseUrls: ["http://localhost:11434"],
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    expect(router.isPrimaryLocal).toBe(true);
    expect(router.cloudReachable).toBe(false);
    db.close();
  });

  test("local primary, cloud fallback → cloud IS reachable", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
        fallback: { provider: "openai", model: "m", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
        trustedBaseUrls: ["http://localhost:11434", "https://api.openai.com/v1"],
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    expect(router.isPrimaryLocal).toBe(true);
    expect(router.cloudReachable).toBe(true); // fallback makes it reachable
    db.close();
  });

  test("cloud primary, no fallback → cloud IS reachable", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const router = new InferenceRouter(
      {
        primary: { provider: "openai", model: "m", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
        trustedBaseUrls: ["https://api.openai.com/v1"],
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    expect(router.isPrimaryLocal).toBe(false);
    expect(router.cloudReachable).toBe(true);
    db.close();
  });

  test("local primary, local fallback → cloud NOT reachable (both loopback)", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "a", baseUrl: "http://localhost:11434" },
        fallback: { provider: "ollama", model: "b", baseUrl: "http://localhost:11435" },
        trustedBaseUrls: ["http://localhost:11434", "http://localhost:11435"],
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    expect(router.cloudReachable).toBe(false);
    db.close();
  });

  test("127.0.0.1 is treated as local", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://127.0.0.1:11434" },
        trustedBaseUrls: ["http://127.0.0.1:11434"],
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    expect(router.isPrimaryLocal).toBe(true);
    expect(router.cloudReachable).toBe(false);
    db.close();
  });
});
