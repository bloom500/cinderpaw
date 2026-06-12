/**
 * Controls-panel inference overrides: host-supplied temperature/max_tokens
 * must be validated and clamped before reaching the router.
 */
import { describe, it, expect } from "bun:test";
import { sanitizeInferParams } from "../src/core/agent-loop.ts";

describe("sanitizeInferParams", () => {
  it("passes through valid values", () => {
    expect(sanitizeInferParams({ temperature: 0.7, max_tokens: 4096 })).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
    });
  });

  it("clamps out-of-range values", () => {
    expect(sanitizeInferParams({ temperature: 99, max_tokens: 10_000_000 })).toEqual({
      temperature: 2,
      maxTokens: 32_768,
    });
    expect(sanitizeInferParams({ temperature: -1, max_tokens: 1 })).toEqual({
      temperature: 0,
      maxTokens: 128,
    });
  });

  it("drops non-numeric and non-finite values", () => {
    expect(sanitizeInferParams({ temperature: "hot", max_tokens: NaN })).toEqual({});
    expect(sanitizeInferParams({})).toEqual({});
  });

  it("floors fractional max_tokens", () => {
    expect(sanitizeInferParams({ max_tokens: 1024.7 })).toEqual({ maxTokens: 1024 });
  });
});
