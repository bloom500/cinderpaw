/**
 * P1-#1: relaxed token budget + soft warning event.
 *
 * Two scenarios:
 *   1. The default budget caps are no longer `Infinity` — they're
 *      relaxed but real (5M per conversation, 50M per day), so a
 *      runaway agent stops somewhere instead of burning money forever.
 *   2. The router fires a `budget_warning` event ONCE per
 *      (sessionId, kind) when usage crosses 80% of the limit, so the
 *      UI can show "approaching limit" before the hard stop kicks in.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import type { BudgetWarning } from "../src/types.ts";

const BUDGET = {
  perConversation: 1000, // tiny so we can hit 80% = 800 with one mocked call
  perDay: 5000,
  onExhausted: "stop" as const,
};

function newRouter(): {
  router: InferenceRouter;
  warnings: BudgetWarning[];
  db: ReturnType<typeof openDatabase>;
} {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const router = new InferenceRouter(
    {
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      tokenBudget: BUDGET,
    },
    audit.logger,
    db.raw,
  );
  const warnings: BudgetWarning[] = [];
  router.setBudgetWarningListener((w) => warnings.push(w));
  return { router, warnings, db };
}

describe("InferenceRouter — soft budget warning (P1-#1)", () => {
  test("fires once when conversation usage crosses 80% of the limit", async () => {
    // Mock Ollama: return a response with eval_count = 900 (above 80% of 1000).
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            message: { content: "ok" },
            prompt_eval_count: 10,
            eval_count: 900,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;

      const { router, warnings, db } = newRouter();
      await router.complete({ sessionId: "s1", messages: [] });
      // Conversation now at 910 → above 80% (800) → warning fired.
      expect(warnings.length).toBe(1);
      expect(warnings[0]?.kind).toBe("conversation");
      expect(warnings[0]?.usage).toBe(910);
      expect(warnings[0]?.limit).toBe(1000);
      expect(warnings[0]?.percent).toBeGreaterThanOrEqual(80);
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does NOT fire when usage stays under the threshold", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            message: { content: "ok" },
            prompt_eval_count: 10,
            eval_count: 100, // 100 < 800 (80% of 1000)
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;

      const { router, warnings, db } = newRouter();
      await router.complete({ sessionId: "s1", messages: [] });
      expect(warnings.length).toBe(0);
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fires at most once per session+kind (no spam)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // eval_count = 250 → cumulative after each call: 260, 520, 780, 1040…
      // The 4th call crosses 800 (warn) and 1000 (limit). The 5th call
      // throws BudgetExhaustedError, so the loop catches it.
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            message: { content: "ok" },
            prompt_eval_count: 10,
            eval_count: 250,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;

      const { router, warnings, db } = newRouter();
      // 4 calls should succeed (cumulative 1040). 5th call throws.
      for (let i = 0; i < 4; i++) {
        await router.complete({ sessionId: "s1", messages: [] });
      }
      await expect(router.complete({ sessionId: "s1", messages: [] })).rejects.toThrow();
      // Warning fired exactly once — on the 4th call when usage first
      // crossed 800. The 5th call threw before recordUsage, so it
      // couldn't re-fire.
      const conversationWarnings = warnings.filter((w) => w.kind === "conversation");
      expect(conversationWarnings.length).toBe(1);
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("different sessions get independent warnings", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            message: { content: "ok" },
            prompt_eval_count: 10,
            eval_count: 900,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;

      const { router, warnings, db } = newRouter();
      await router.complete({ sessionId: "s1", messages: [] });
      await router.complete({ sessionId: "s2", messages: [] });
      expect(warnings.length).toBe(2);
      expect(warnings[0]?.sessionId).toBe("s1");
      expect(warnings[1]?.sessionId).toBe("s2");
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("hard stop still fires on the NEXT call after the warning (defense in depth)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // eval_count = 900 → first call: 910 (above 800 warn threshold, below 1000 limit)
      // second call: 1810 (above 1000 limit → next call should throw)
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            message: { content: "ok" },
            prompt_eval_count: 10,
            eval_count: 900,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;

      const { router, warnings, db } = newRouter();
      // First call: 910, fires warning.
      await router.complete({ sessionId: "s1", messages: [] });
      expect(warnings.length).toBe(1);
      // Second call: 1810, no new warning (already fired).
      await router.complete({ sessionId: "s1", messages: [] });
      expect(warnings.length).toBe(1);
      // Third call: enforceBudget fires first (1810 > 1000) → throws.
      await expect(router.complete({ sessionId: "s1", messages: [] })).rejects.toThrow();
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Token budget defaults — no longer Infinity (P1-#1)", () => {
  test("soft-warn ratio is 80% (documented behavior)", () => {
    // The constant is the contract: any future tuning must update tests too.
    expect(InferenceRouter.SOFT_WARN_RATIO).toBe(0.8);
  });
});
