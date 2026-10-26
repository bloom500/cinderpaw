import { expect, test } from "bun:test";
import { InferenceSpendAuthority } from "../src/egress/inference-spend-authority.ts";
import { priceResolverFromJson } from "../src/rsi/infra/rsi-cost.ts";

// A fresh install sets no price catalog. A confirmed agent task on the
// person's own cloud key must still run, counted at the dear fallback price.
test("a fresh install with a cloud key can run a confirmed agent task", () => {
  const authority = new InferenceSpendAuthority({
    maxCostUsd: 5,
    allowCloud: true,
    price: priceResolverFromJson(undefined),
  });
  const target = { provider: "anthropic", model: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com/v1" };
  expect(() => authority.reserve({ targets: [target], maxPromptTokens: 40_000, maxCompletionTokens: 4_000 })).not.toThrow();
});
