import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import {
  AutonomousSpendDeniedError,
  InferenceSpendAuthority,
  type SpendTarget,
} from "../src/egress/inference-spend-authority.ts";

const known: SpendTarget = {
  provider: "known",
  model: "priced-model",
  baseUrl: "https://api.example.test/v1",
};

const unknown: SpendTarget = {
  provider: "unknown",
  model: "mystery-model",
  baseUrl: "https://unknown.example.test/v1",
};

describe("InferenceSpendAuthority", () => {
  test("refuses an autonomous request before reserving when any possible cloud route has unknown pricing", () => {
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 1,
      allowCloud: true,
      price: (target) => target.provider === "known"
        ? { inputPerMillionUsd: 10, outputPerMillionUsd: 20 }
        : null,
    });

    expect(() => authority.reserve({
      targets: [known, unknown],
      maxPromptTokens: 500,
      maxCompletionTokens: 500,
    })).toThrow(AutonomousSpendDeniedError);
    expect(authority.reservedUsd).toBe(0);
    expect(authority.spentUsd).toBe(0);
  });

  test("counts in-flight reservations so concurrent requests cannot oversubscribe the USD cap", () => {
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 0.015,
      allowCloud: true,
      price: () => ({ inputPerMillionUsd: 10, outputPerMillionUsd: 10 }),
    });

    const first = authority.reserve({ targets: [known], maxPromptTokens: 500, maxCompletionTokens: 500 });
    expect(authority.reservedUsd).toBeCloseTo(0.01);
    expect(() => authority.reserve({
      targets: [known],
      maxPromptTokens: 500,
      maxCompletionTokens: 500,
    })).toThrow(AutonomousSpendDeniedError);

    first.settle({ target: known, usage: { promptTokens: 250, completionTokens: 250 } });
    expect(authority.reservedUsd).toBe(0);
    expect(authority.spentUsd).toBeCloseTo(0.005);

    expect(() => authority.reserve({
      targets: [known],
      maxPromptTokens: 500,
      maxCompletionTokens: 500,
    })).not.toThrow();
  });

  test("charges local loopback targets at zero without requiring a cloud price", () => {
    const local = { ...known, baseUrl: "http://127.0.0.1:11435" };
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 0,
      allowCloud: false,
      price: () => null,
    });

    const reservation = authority.reserve({
      targets: [local],
      maxPromptTokens: 50_000,
      maxCompletionTokens: 50_000,
    });
    reservation.settle({ target: local, usage: { promptTokens: 50_000, completionTokens: 50_000 } });

    expect(authority.reservedUsd).toBe(0);
    expect(authority.spentUsd).toBe(0);
  });

  test("stop aborts the shared signal and rejects every later reservation", () => {
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 1,
      allowCloud: true,
      price: () => ({ inputPerMillionUsd: 10, outputPerMillionUsd: 10 }),
    });

    authority.stop("user stopped");

    expect(authority.signal.aborted).toBe(true);
    expect(authority.signal.reason).toBe("user stopped");
    expect(() => authority.reserve({
      targets: [known],
      maxPromptTokens: 1,
      maxCompletionTokens: 0,
    })).toThrow(AutonomousSpendDeniedError);
  });

  test("the router reserves before fetch and blocks an unknown-price autonomous route at the network boundary", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 1,
      allowCloud: true,
      price: () => null,
    });
    const router = new InferenceRouter({
      primary: known,
      tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" },
    }, audit.logger, db.raw);
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("network must not be reached");
    }) as typeof fetch;

    try {
      await expect(router.complete({
        sessionId: "rsi-eval-g1",
        messages: [{ role: "user", content: "evaluate" }],
        maxTokens: 100,
        spendAuthority: authority,
      })).rejects.toBeInstanceOf(AutonomousSpendDeniedError);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  test("reserves the worst split rate and settles prompt/output/cache categories separately", () => {
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 1,
      allowCloud: true,
      price: () => ({
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 10,
        cacheReadPerMillionUsd: 0.5,
        cacheWritePerMillionUsd: 3,
      }),
    });

    const reservation = authority.reserve({
      targets: [known],
      maxPromptTokens: 100_000,
      maxCompletionTokens: 50_000,
    });
    expect(authority.reservedUsd).toBeCloseTo(0.8);

    reservation.settle({
      target: known,
      usage: {
        promptTokens: 20_000,
        completionTokens: 5_000,
        freshPromptTokens: 10_000,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 2_000,
      },
    });
    expect(authority.spentUsd).toBeCloseTo(0.08);
  });

  test("re-checks cloud opt-in at every reservation so a hot-swapped route cannot inherit local authority", () => {
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 1,
      allowCloud: false,
      price: () => ({ inputPerMillionUsd: 1, outputPerMillionUsd: 1 }),
    });

    expect(() => authority.reserve({
      targets: [known],
      maxPromptTokens: 1,
      maxCompletionTokens: 1,
    })).toThrow(new AutonomousSpendDeniedError(
      "cloud_not_allowed",
      "autonomous cloud inference is not authorized for known/priced-model",
    ));
  });

  test("charges an indeterminate failed attempt before authorizing fallback", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const primary = { ...known, provider: "openai" };
    const fallback = { ...primary, model: "fallback", baseUrl: "https://fallback.example.test/v1" };
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 0.15,
      allowCloud: true,
      price: () => ({ inputPerMillionUsd: 0, outputPerMillionUsd: 1_000 }),
    });
    const router = new InferenceRouter({
      primary,
      fallback,
      tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" },
    }, audit.logger, db.raw);
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new TypeError("connection reset after request upload");
    }) as typeof fetch;

    try {
      await expect(router.complete({
        sessionId: "rsi-eval-fallback-cap",
        messages: [{ role: "user", content: "evaluate" }],
        maxTokens: 100,
        spendAuthority: authority,
      })).rejects.toBeInstanceOf(AutonomousSpendDeniedError);
      expect(calls).toBe(1);
      expect(authority.spentUsd).toBeCloseTo(0.1);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  test("background cancellation interrupts the interactive-priority wait before any network call", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const target = { ...known, provider: "openai" };
    const router = new InferenceRouter({
      primary: target,
      tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" },
    }, audit.logger, db.raw);
    const originalFetch = globalThis.fetch;
    let releaseInteractive!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return await new Promise<Response>((resolve) => {
        releaseInteractive = resolve;
      });
    }) as typeof fetch;

    try {
      const interactive = router.complete({
        sessionId: "chat-1",
        messages: [{ role: "user", content: "hold the foreground slot" }],
      });
      while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));

      const ac = new AbortController();
      const background = router.complete({
        sessionId: "rsi-eval-waiting",
        messages: [{ role: "user", content: "background" }],
        signal: ac.signal,
      });
      ac.abort(new DOMException("stopped", "AbortError"));
      await expect(background).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toBe(1);

      releaseInteractive(new Response(JSON.stringify({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
      await interactive;
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

});
