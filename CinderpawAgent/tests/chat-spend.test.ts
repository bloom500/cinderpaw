import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { ChatSpendRepo, chatSessionOf } from "../src/egress/chat-spend.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { loadModelPrices } from "../src/egress/model-prices.ts";

test("reserves atomically across calls and keeps an unfinished charge through restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "cinderpaw-chat-spend-"));
  const path = join(dir, "test.db");
  let db = new Database(path);
  try {
    let ledger = new ChatSpendRepo(db);
    expect(ledger.get("chat-a")).toEqual({ limitUsd: null, usedUsd: 0 });
    ledger.setLimit("chat-a", 0.1);
    expect(ledger.account("chat-a").hold(0.08)).toBe(true);
    expect(ledger.account("chat-a").hold(0.03)).toBe(false);
    ledger.account("chat-a").settle(0.08, 0.02);
    expect(ledger.account("chat-a").hold(0.07)).toBe(true);
    db.close();
    db = new Database(path);
    ledger = new ChatSpendRepo(db);
    expect(ledger.get("chat-a")).toEqual({ limitUsd: 0.1, usedUsd: 0.09 });
    expect(ledger.account("chat-a").hold(0.02)).toBe(false);
    expect(ledger.get("chat-b")).toEqual({ limitUsd: null, usedUsd: 0 });
    expect(ledger.setLimit("chat-a", null)).toEqual({ limitUsd: null, usedUsd: 0.09 });
    expect(() => ledger.setLimit("chat-b", 0.001)).toThrow();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("direct chats, derived sessions and delegated turns use the correct budget", () => {
  const threadOf = (id: string) => id === "scout" ? "chat-a" : null;
  expect(chatSessionOf("subagent:subagent:cowork:scout:child:grandchild", threadOf)).toBe("chat-a");
  expect(chatSessionOf("cowork:scout__facts", threadOf)).toBe("chat-a");
  expect(chatSessionOf("cowork:tally", threadOf)).toBe("cowork:tally");
  expect(chatSessionOf("chat-b__obs", threadOf)).toBe("chat-b");
});

test("OpenRouter uses the provider price ceiling and never receives a call that will exceed the chat limit", async () => {
  const db = openDatabase(":memory:");
  const ledger = new ChatSpendRepo(db.raw);
  const model = "example/capped-model";
  loadModelPrices({ data: [{ id: model, pricing: { prompt: "0.000001", completion: "0.00001" } }] });
  const router = new InferenceRouter({
    primary: { baseUrl: "https://openrouter.ai/api", provider: "openai", model },
    tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" },
  }, new AuditLog(db.raw).logger, db.raw);
  router.configureChatSpend({ repo: ledger, sessionOf: () => "chat-a" });
  ledger.setLimit("chat-a", 0.05);
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: "Done" } }], usage: { prompt_tokens: 10, completion_tokens: 8, cost: 0.015 } });
  }) as typeof fetch;

  try {
    const request = { sessionId: "cowork:scout", messages: [{ role: "user" as const, content: "Help with this." }] };
    await router.complete(request);
    expect(bodies[0]).toMatchObject({
      max_tokens: 4096,
      provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1, completion: 10, request: 0, image: 0 } },
    });
    expect(ledger.get("chat-a").usedUsd).toBe(0.015);
    await expect(router.complete(request)).rejects.toThrow("would exceed this chat’s spending limit");
    await expect(router.complete({ ...request, messages: [{ ...request.messages[0]!, images: ["data:image/png;base64,AA=="] }] }))
      .rejects.toThrow("supports OpenRouter text calls");
    expect(bodies).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
