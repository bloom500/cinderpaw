/** A spent or dead AI key is named on chat connectors; other failures keep the plain apology. */
import { expect, test } from "bun:test";
import { keyTrouble } from "../src/transports/connectors.ts";

test("OpenRouter's spent key limit (403) and a 402 say 'out of credit'", () => {
  const seen = 'returned 403: {"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/..."}}';
  expect(keyTrouble(seen)).toContain("out of credit");
  expect(keyTrouble("402 insufficient credits")).toContain("out of credit");
});

test("a revoked key says to connect a new one", () => {
  expect(keyTrouble("401 Unauthorized: invalid api key")).toContain("connect a new one");
});

test("a rate limit or anything else is not blamed on the key", () => {
  expect(keyTrouble("429 rate limit exceeded")).toBeNull();
  expect(keyTrouble("socket hang up")).toBeNull();
});
