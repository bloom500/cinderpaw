/**
 * The benchmark reproducibility guard.
 *
 * OpenRouter picks an endpoint per request. On 2026-09-02 the same 21 telecom
 * tasks — same seed, same model, unchanged agent code — scored 11/21 and then
 * 20/21, with nine tasks flipping the same way and their conversations
 * collapsing from 201 messages to 34-72. A score that moves 40 points between
 * identical runs is not a measurement.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { openRouterProviderPin } from "../src/egress/inference-providers.ts";
import type { ModelTarget } from "../src/types.ts";

const OR = { model: "z-ai/glm-5.3-flash", baseUrl: "https://openrouter.ai/api/v1" } as ModelTarget;
const LOCAL = { model: "qwen", baseUrl: "http://127.0.0.1:11434/v1" } as ModelTarget;

const orig = process.env.CINDERPAW_OPENROUTER_PROVIDER;
afterEach(() => {
  if (orig === undefined) delete process.env.CINDERPAW_OPENROUTER_PROVIDER;
  else process.env.CINDERPAW_OPENROUTER_PROVIDER = orig;
});

describe("openRouterProviderPin", () => {
  test("off unless asked — a fresh install keeps its fallbacks", () => {
    delete process.env.CINDERPAW_OPENROUTER_PROVIDER;
    expect(openRouterProviderPin(OR)).toEqual({});
    process.env.CINDERPAW_OPENROUTER_PROVIDER = "   ";
    expect(openRouterProviderPin(OR)).toEqual({});
  });

  test("pins one provider and refuses to fall back", () => {
    process.env.CINDERPAW_OPENROUTER_PROVIDER = "Z.AI";
    // allow_fallbacks:false is the whole point — a pin that silently routes
    // elsewhere measures nothing, which is the bug this exists to prevent.
    expect(openRouterProviderPin(OR)).toEqual({
      provider: { order: ["Z.AI"], allow_fallbacks: false },
    });
  });

  test("never leaks onto a non-OpenRouter target", () => {
    // `provider` is an OpenRouter extension. Sending it to a local llama.cpp or
    // to OpenAI is at best ignored and at worst a 400 on a strict server.
    process.env.CINDERPAW_OPENROUTER_PROVIDER = "Z.AI";
    expect(openRouterProviderPin(LOCAL)).toEqual({});
  });
});
