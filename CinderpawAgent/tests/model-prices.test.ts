import { expect, test } from "bun:test";
import { loadModelPrices, withModelPrices } from "../src/egress/model-prices.ts";
import { priceResolverFromJson, UNKNOWN_CLOUD_PRICE } from "../src/rsi/infra/rsi-cost.ts";
import { createTaskLimitTool } from "../src/tools/builtin/task-limit.ts";
import { TaskLimit } from "../src/cron/limit.ts";
import { openDatabase } from "../src/db.ts";

test("list prices replace the dear fallback for a direct key; unknown and local models keep theirs", () => {
  loadModelPrices({ data: [
    { id: "anthropic/claude-haiku-4.5", pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001" } },
    { id: "openai/gpt-5", pricing: { prompt: "0.00000125", completion: "0.00001" } },
  ] });
  const price = withModelPrices(priceResolverFromJson(undefined));
  const haiku = price({ provider: "anthropic", model: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com/v1" })!;
  expect(haiku).toMatchObject({ inputPerMillionUsd: 1, outputPerMillionUsd: 5 });
  expect(haiku.cacheReadPerMillionUsd).toBeCloseTo(0.1);
  expect(price({ provider: "openrouter", model: "openai/gpt-5", baseUrl: "https://openrouter.ai/api/v1" })?.outputPerMillionUsd).toBe(10);
  // A dated snapshot is the same model.
  expect(price({ provider: "anthropic", model: "claude-haiku-4-5-20251001", baseUrl: "https://api.anthropic.com" })?.inputPerMillionUsd).toBe(1);
  // No substring guessing: a model the list does not name stays dear.
  expect(price({ provider: "anthropic", model: "claude-haiku-4", baseUrl: "https://api.anthropic.com" })).toEqual({ ...UNKNOWN_CLOUD_PRICE });
  expect(price({ provider: "x", model: "anthropic/claude-haiku-4.5", baseUrl: "https://proxy.example.com" })).toEqual({ ...UNKNOWN_CLOUD_PRICE });
  expect(price({ provider: "ollama", model: "anything", baseUrl: "http://localhost:11434" })).toEqual({ inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
});

test("the agent reads, raises and removes the weekly limit when asked", async () => {
  const db = openDatabase(":memory:");
  const tool = createTaskLimitTool(new TaskLimit(db.raw));
  const ctx = {} as never;
  expect((await tool.execute({}, ctx)).content).toContain("No weekly limit");
  expect((await tool.execute({ weekly_usd: 10 }, ctx)).content).toContain("$10.00");
  expect((await tool.execute({ remove: true }, ctx)).content).toContain("No weekly limit");
  expect((await tool.execute({ weekly_usd: 0 }, ctx)).ok).toBe(false);
  db.close();
});
