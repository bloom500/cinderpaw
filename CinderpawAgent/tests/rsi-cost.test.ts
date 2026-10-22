// CinderpawAgent/tests/rsi-cost.test.ts
import { describe, it, expect } from "bun:test";
import {
  blendedPricePer1kUsd,
  estimateUsd,
  priceResolverFromJson,
  UNKNOWN_CLOUD_PRICE,
} from "../src/rsi/infra/rsi-cost.ts";

describe("rsi-cost", () => {
  it("local loopback routes are always free without a catalog entry", () => {
    const resolve = priceResolverFromJson(null);
    expect(resolve({ provider: "anything", model: "anything", baseUrl: "http://127.0.0.1:11435" }))
      .toEqual({ inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
    expect(blendedPricePer1kUsd("anything", true)).toBe(0);
  });

  it("a cloud route nobody priced is charged the dear end, never refused", () => {
    // A stranger has no price catalog. Refusing every unknown model meant a
    // cloud user who allowed dreaming and set a cap never dreamed at all.
    const resolve = priceResolverFromJson(null);
    expect(resolve({ provider: "anthropic", model: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com" }))
      .toEqual(UNKNOWN_CLOUD_PRICE);
    expect(UNKNOWN_CLOUD_PRICE.inputPerMillionUsd).toBeGreaterThanOrEqual(10);
    expect(UNKNOWN_CLOUD_PRICE.outputPerMillionUsd).toBeGreaterThanOrEqual(50);
  });

  it("matches cloud pricing only on the exact provider/model/baseUrl tuple", () => {
    const resolve = priceResolverFromJson(JSON.stringify([{
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1/",
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 8,
      cacheReadPerMillionUsd: 1,
    }]));
    expect(resolve({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    })).toEqual({
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 8,
      cacheReadPerMillionUsd: 1,
    });
    expect(resolve({
      provider: "proxy",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    })).toEqual(UNKNOWN_CLOUD_PRICE);
    expect(resolve({
      provider: "openai",
      model: "gpt-4o-mini-proxy",
      baseUrl: "https://api.openai.com/v1",
    })).toEqual(UNKNOWN_CLOUD_PRICE);
    expect(resolve({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://proxy.example/v1",
    })).toEqual(UNKNOWN_CLOUD_PRICE);
  });

  it("trusts no row of a malformed catalog: every cloud route falls to the dear end", () => {
    expect(priceResolverFromJson("not-json")({
      provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com/v1",
    })).toEqual(UNKNOWN_CLOUD_PRICE);
    expect(priceResolverFromJson(JSON.stringify([{
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      inputPerMillionUsd: -1,
      outputPerMillionUsd: 1,
    }]))({
      provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com/v1",
    })).toEqual(UNKNOWN_CLOUD_PRICE);
  });

  it("keeps legacy display estimates separate from authorization", () => {
    expect(blendedPricePer1kUsd("some-cloud-model", false)).toBeGreaterThan(0);
    expect(estimateUsd(0, 5)).toBe(0);
    expect(estimateUsd(1000, 5)).toBeCloseTo(5, 6);
    expect(estimateUsd(2500, 4)).toBeCloseTo(10, 6);
  });
});
