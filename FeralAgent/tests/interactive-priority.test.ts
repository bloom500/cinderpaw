/**
 * Interactive-priority gate (2026-07-11): background inference (RSI evals,
 * dreams) must wait while a user-facing request is in flight. Repro of the
 * field failure: an RSI eval sweep saturated MiniMax while the user's chat
 * message starved past the 90s first-token timeout.
 */
import { describe, expect, test } from "bun:test";
import { isBackgroundSession } from "../src/egress/inference-router";

describe("isBackgroundSession", () => {
  test("classifies background work", () => {
    for (const id of [
      "rsi-eval-genome-42",
      "rsi-eval-genome-42#p2",
      "code-rsi-proposer",
      "inner-thoughts",
      "semantic",
      "migration",
      "dream-cycle-1",
      "meta-evolve",
    ]) {
      expect(isBackgroundSession(id)).toBe(true);
    }
  });

  test("user-facing sessions stay interactive", () => {
    for (const id of [
      "chat",
      "plain",
      "api",
      "discord-195569970095194113",
      "whatsapp-40740000000",
      "recall-tool",
      "mcp",
    ]) {
      expect(isBackgroundSession(id)).toBe(false);
    }
  });
});
