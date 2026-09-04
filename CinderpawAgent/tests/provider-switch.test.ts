/**
 * Pre-release hardening (2026-07-31) — provider switching (release blocker #2).
 *
 * `reconfigure()` is the runtime provider-switch entry point: `dispatch.ts` calls it
 * when the host forwards a `set_model` message. Before this file it had ZERO test
 * coverage — the only occurrences of `reconfigure` under tests/ were no-op stubs in
 * test doubles. Its behaviour was therefore asserted only by inspection, which the
 * hardening mission explicitly rejects ("Do not mark them resolved because the code
 * looks correct").
 *
 * These tests pin the four properties a provider switch must hold:
 *
 *   1. the switch actually takes effect for subsequent completions
 *   2. it does NOT widen the trusted-URL boundary (a switch is not a security escape)
 *   3. a rejected switch leaves the previous target intact (no half-applied state)
 *   4. an in-flight completion is unaffected — it snapshots its targets at call time,
 *      which is what `reconfigure`'s docstring promises
 *
 * Plus the mission's two named scenarios:
 *   A → execute → switch → continue
 *   A → failure → B → continue
 */

import { afterEach, describe, expect, test } from "bun:test";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter, InferenceError } from "../src/egress/inference-router.ts";
import type { InferenceConfig } from "../src/types.ts";

const BUDGET = {
  perConversation: 500_000,
  perDay: 5_000_000,
  onExhausted: "stop",
} as const;

const OLLAMA_OK = {
  message: { content: "hi" },
  prompt_eval_count: 11,
  eval_count: 7,
};

/** Records every fetched URL; optionally fails specific hosts. */
function installFetchMock(opts: { failUrlsContaining?: string[] } = {}) {
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
    if (opts.failUrlsContaining?.some((frag) => url.includes(frag))) {
      return new Response("upstream exploded", { status: 500 });
    }
    return new Response(JSON.stringify(OLLAMA_OK), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

const A = { provider: "ollama", model: "model-a", baseUrl: "http://localhost:11434" };
const B = { provider: "ollama", model: "model-b", baseUrl: "http://localhost:11435" };
const UNTRUSTED = { provider: "ollama", model: "evil", baseUrl: "http://evil.example.com" };

// `null` = no allowlist configured at all. Not `undefined`: that is what a default
// parameter substitutes for, so it could never express "omitted".
function newRouter(trustedBaseUrls: string[] | null = [A.baseUrl, B.baseUrl]) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const config: InferenceConfig = {
    primary: A,
    ...(trustedBaseUrls ? { trustedBaseUrls } : {}),
    tokenBudget: BUDGET,
  };
  return { router: new InferenceRouter(config, audit.logger, db.raw), db };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("provider switch — reconfigure() takes effect", () => {
  test("A → execute → switch to B → continue: the same session routes to B", async () => {
    const { router, db } = newRouter();
    const mock = installFetchMock();
    restoreFetch = mock.restore;

    await router.complete({ sessionId: "s1", messages: [{ role: "user", content: "one" }] });
    expect(mock.calls.at(-1)).toBe("http://localhost:11434/api/chat");

    router.reconfigure(B);

    // Same sessionId — a switch must not require a new session.
    const res = await router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "two" }],
    });

    expect(res.content).toBe("hi");
    expect(mock.calls.at(-1)).toBe("http://localhost:11435/api/chat");
    expect(router.currentModel.model).toBe("model-b");
    db.close();
  });

  test("switch updates the reported current model and fallback", async () => {
    const { router, db } = newRouter();
    expect(router.currentModel.model).toBe("model-a");
    expect(router.currentFallback).toBeNull();

    router.reconfigure(B, A);

    expect(router.currentModel.model).toBe("model-b");
    expect(router.currentFallback?.model).toBe("model-a");
    db.close();
  });
});

describe("provider switch — failover still works after a switch", () => {
  test("A → failure → B → continue: fallback serves the request", async () => {
    const { router, db } = newRouter();
    const mock = installFetchMock({ failUrlsContaining: [":11434"] });
    restoreFetch = mock.restore;

    // Primary A is broken, B is the configured fallback.
    router.reconfigure(A, B);

    const res = await router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.content).toBe("hi");
    // A was attempted at least once, then B served it.
    expect(mock.calls.some((u) => u.includes(":11434"))).toBe(true);
    expect(mock.calls.at(-1)).toBe("http://localhost:11435/api/chat");
    db.close();
  });
});

describe("provider switch — trusted-URL boundary (F-03, RESOLVED)", () => {
  /**
   * The boundary question these tests were drafted to pin — is the host's `set_model`
   * channel the authority, or is `trustedBaseUrls` a floor? — was answered: it is a
   * floor. An operator who names an explicit allowlist keeps it across hot-swaps.
   *
   * The bug was that `reconfigure()`'s validation loop built its trusted set FROM the
   * targets it was about to validate: `#buildTrusted` falls back to
   * `[primary.baseUrl, fallback.baseUrl]` when no explicit list is passed, and
   * `dispatch.ts:992` never passes one. So the loop could not fire, and the operator's
   * list was silently discarded at the first `set_model`. `reconfigure` now falls back
   * to the configured list instead of to the incoming targets.
   *
   * Unchanged when NO list is configured (the default, and every shipped install):
   * the trusted set is still derived from the targets and any endpoint is reachable —
   * gated by the host channel, which is loopback-only + bearer token (`api.rs`).
   */
  test("switching to a previously-untrusted primary is REFUSED", () => {
    const { router, db } = newRouter();
    expect(() => router.reconfigure(UNTRUSTED)).toThrow(InferenceError);
    // Rejected switch must not half-apply.
    expect(router.currentModel.baseUrl).toBe(A.baseUrl);
    db.close();
  });

  test("the allowlist survives a hot-swap — it is not replaced by the target", () => {
    const { router, db } = newRouter();
    // B is on the list, so this switch is fine…
    router.reconfigure(B);
    expect(router.currentModel.model).toBe("model-b");
    // …and it must not have narrowed the list to just B, nor widened it to allow evil.
    expect(() => router.reconfigure(UNTRUSTED)).toThrow(InferenceError);
    router.reconfigure(A);
    expect(router.currentModel.model).toBe("model-a");
    db.close();
  });

  test("with NO configured allowlist, any target is accepted (unchanged default)", () => {
    const { router, db } = newRouter(null);
    router.reconfigure(UNTRUSTED);
    expect(router.currentModel.baseUrl).toBe(UNTRUSTED.baseUrl);
    db.close();
  });

  test("a switch to an allowlisted target still routes there", async () => {
    const { router, db } = newRouter();
    const mock = installFetchMock();
    restoreFetch = mock.restore;

    router.reconfigure(B);
    expect(router.currentModel.model).toBe("model-b");

    const res = await router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("hi");
    expect(mock.calls.at(-1)).toBe("http://localhost:11435/api/chat");
    db.close();
  });

  test("an explicit trustedUrls list IS enforced when one is supplied", () => {
    const { router, db } = newRouter();
    // The only call shape where the validation loop is reachable: caller passes an
    // explicit allowlist that excludes the target. dispatch.ts does not do this today.
    expect(() => router.reconfigure(UNTRUSTED, undefined, [A.baseUrl, B.baseUrl])).toThrow(
      InferenceError,
    );
    // Rejected switch must not half-apply.
    expect(router.currentModel.model).toBe("model-a");
    db.close();
  });
});

describe("provider switch — in-flight completions are unaffected", () => {
  test("a switch during an in-flight completion does not redirect it", async () => {
    const { router, db } = newRouter();
    const original = globalThis.fetch;
    const calls: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const firstStarted = Promise.withResolvers<void>();

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(url);
      if (calls.length === 1) {
        firstStarted.resolve();
        // Hold the first request open until the switch has been applied.
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      }
      return new Response(JSON.stringify(OLLAMA_OK), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    restoreFetch = () => (globalThis.fetch = original);

    const inFlight = router.complete({
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });
    await firstStarted.promise;

    // Swap the provider while the first completion is still open.
    router.reconfigure(B);
    releaseFirst!();

    await inFlight;

    // The in-flight call stayed on A — it snapshotted its target at call time.
    expect(calls[0]).toBe("http://localhost:11434/api/chat");
    // And the NEXT call picks up B.
    await router.complete({ sessionId: "s1", messages: [{ role: "user", content: "next" }] });
    expect(calls.at(-1)).toBe("http://localhost:11435/api/chat");
    db.close();
  });
});
