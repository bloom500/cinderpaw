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
